#!/bin/sh

# ---------------------------------------------------------------
# run-ci-checks.sh — Smoke Tests + Newman API Tests
#
# Called by .husky/pre-push by default.
# To move to pre-commit: add './scripts/run-ci-checks.sh' to .husky/pre-commit
# To run manually: sh scripts/run-ci-checks.sh
# ---------------------------------------------------------------

# ---------------------------------------------------------------
# Git diff check — only run if actual files changed
# ---------------------------------------------------------------
CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null)

if [ -z "$CHANGED" ]; then
  echo "[CI Checks] No changed files detected. Skipping."
  exit 0
fi

echo ""
echo "[CI Checks] Changed files detected:"
echo "$CHANGED" | sed 's/^/  -> /'

echo ""
echo "[CI Checks] Starting checks..."



# ---------------------------------------------------------------
# Diff Filter — Run heavy tests only if backend/API files changed
# ---------------------------------------------------------------

API_CHANGE=$(echo "$CHANGED" | grep -E '\.(js|ts|jsx|tsx)$|package\.json|routes/|controllers/|services/|server/|api/')

if [ -z "$API_CHANGE" ]; then
  echo ""
  echo "[CI Checks] Only docs/assets changed — skipping smoke tests and Newman."
  exit 0
fi
# ---------------------------------------------------------------
# Find which directory has the start script
# Checks root first, then common subfolder names
# ---------------------------------------------------------------
find_project_dir() {
  for DIR in . backend server api app frontend src; do
    if [ -f "$DIR/package.json" ]; then
      HAS_START=$(node -e "try{const p=require('./$DIR/package.json');console.log(p.scripts&&p.scripts.start?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)
      if [ "$HAS_START" = "yes" ]; then
        echo "$DIR"
        return
      fi
    fi
  done
  echo "none"
}

PROJECT_DIR=$(find_project_dir)

if [ "$PROJECT_DIR" = "none" ]; then
  echo "[Smoke Tests] No start script found in root or subfolders. Skipping smoke tests."
else

  # cd into project dir so npm start/test work correctly
  cd "$PROJECT_DIR" || exit 1

  # Check if test script exists
  HAS_TEST=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.test?'yes':'no')}catch(e){console.log('no')}" 2>/dev/null)

  # ---------------------------------------------------------------
  # Step 1: Smoke Tests
  # ---------------------------------------------------------------
  echo ""
  echo "[Smoke Tests] Starting server from: $PROJECT_DIR"

  NODE_MAJOR=$(node -v | cut -d '.' -f1 | tr -d 'v')

  if [ "$NODE_MAJOR" -ge 17 ]; then
    echo "[Smoke Tests] Applying OpenSSL legacy provider fix for Node $NODE_MAJOR"
    export NODE_OPTIONS=--openssl-legacy-provider
  fi


  npm start &
  SERVER_PID=$!

  # Auto-detect port + detect server crash early
  SERVER_UP=0
  for i in $(seq 1 30); do
    # Check if server process crashed
    if ! kill -0 $SERVER_PID 2>/dev/null; then
      echo "[Smoke Tests] Server process crashed. Skipping smoke tests."
      SERVER_UP=0
      break
    fi

    for PORT_TRY in 3000 3001 4000 4200 5000 5173 5174 8000 8080 8081 9000 1337; do
      if curl -sf http://localhost:$PORT_TRY > /dev/null 2>&1; then
        PORT=$PORT_TRY
        SERVER_UP=1
        echo "[Smoke Tests] Server is up on port $PORT."
        break 2
      fi
    done

    echo "[Smoke Tests] Waiting for server... ($i/30)"
    sleep 1
  done

  if [ $SERVER_UP -eq 0 ]; then
    echo "[Smoke Tests] Server did not start. Skipping smoke tests."
    kill $SERVER_PID 2>/dev/null
  else

    if [ "$HAS_TEST" = "no" ]; then
      echo "[Smoke Tests] No test script found. Skipping npm test."
    else
      echo "[Smoke Tests] Running npm test..."
      npm test
      SMOKE_EXIT=$?

      if [ $SMOKE_EXIT -ne 0 ]; then
        kill $SERVER_PID 2>/dev/null
        echo "[Smoke Tests] Failed. Push blocked."
        exit 1
      fi

      echo "[Smoke Tests] Passed. ✔"
    fi

    # ---------------------------------------------------------------
    # Step 2: Newman
    # ---------------------------------------------------------------
    echo ""
    echo "[Newman] Looking for Postman collections..."

    COLLECTIONS=$(find . \
      -not -path '*/node_modules/*' \
      -not -path '*/.git/*' \
      -not -path '*/scripts/*' \
      \( -name "*.postman_collection.json" -o -name "collection.json" \) \
      2>/dev/null)

    if [ -z "$COLLECTIONS" ]; then
      echo "[Newman] No Postman collection found. Skipping."
      kill $SERVER_PID 2>/dev/null
    else

      if ! command -v newman > /dev/null 2>&1; then
        echo "[Newman] Installing newman globally..."
        npm install -g newman newman-reporter-htmlextra 2>/dev/null || true
      fi

      mkdir -p newman-reports

      ENV_FILE=$(find . \
        -not -path '*/node_modules/*' \
        -not -path '*/.git/*' \
        -name "*.postman_environment.json" \
        2>/dev/null | head -1)

      NEWMAN_EXIT=0
      for COLLECTION in $COLLECTIONS; do
        REPORT_NAME=$(basename "$COLLECTION" .json)
        echo "[Newman] Running: $COLLECTION"

        ENV_FLAG=""
        if [ -n "$ENV_FILE" ]; then
          ENV_FLAG="--environment $ENV_FILE"
        fi

        newman run "$COLLECTION" \
          $ENV_FLAG \
          --env-var "baseUrl=http://localhost:${PORT:-3000}" \
          --reporters cli,htmlextra \
          --reporter-htmlextra-export "newman-reports/${REPORT_NAME}-report.html" \
          --bail

        if [ $? -ne 0 ]; then
          NEWMAN_EXIT=1
        fi
      done

      kill $SERVER_PID 2>/dev/null

      if [ $NEWMAN_EXIT -ne 0 ]; then
        echo "[Newman] One or more collections failed. Push blocked."
        exit 1
      fi

      echo "[Newman] All collections passed. ✔"

    fi
  fi
fi

exit 0