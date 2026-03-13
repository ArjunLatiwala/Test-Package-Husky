#!/bin/sh

# ---------------------------------------------------------------
# run-ci-checks.sh — Smoke Tests + Newman API Tests
#
# Called by .husky/pre-push by default.
# To move to pre-commit: add './scripts/run-ci-checks.sh' to .husky/pre-commit
# To run manually: sh scripts/run-ci-checks.sh
# ---------------------------------------------------------------

echo ""
echo "[CI Checks] Starting checks..."

# ---------------------------------------------------------------
# Step 1: Smoke Tests
# ---------------------------------------------------------------
echo ""
echo "[Smoke Tests] Starting server..."

npm start &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://localhost:${PORT:-3000}/health > /dev/null 2>&1 || \
     curl -sf http://localhost:${PORT:-3000} > /dev/null 2>&1; then
    echo "[Smoke Tests] Server is up."
    break
  fi
  echo "[Smoke Tests] Waiting for server... ($i/30)"
  sleep 1
done

echo "[Smoke Tests] Running npm test..."
npm test
SMOKE_EXIT=$?

kill $SERVER_PID 2>/dev/null

if [ $SMOKE_EXIT -ne 0 ]; then
  echo "[Smoke Tests] Failed. Push blocked."
  exit 1
fi

echo "[Smoke Tests] Passed. ✔"

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
  exit 0
fi

if ! command -v newman > /dev/null 2>&1; then
  echo "[Newman] Installing newman globally..."
  npm install -g newman newman-reporter-htmlextra
fi

npm start &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://localhost:${PORT:-3000}/health > /dev/null 2>&1 || \
     curl -sf http://localhost:${PORT:-3000} > /dev/null 2>&1; then
    echo "[Newman] Server is up."
    break
  fi
  sleep 1
done

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
exit 0
