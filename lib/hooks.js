const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

exports.setupPreCommitHook = async () => {
  const huskyDir = path.join(process.cwd(), '.husky');
  const hookPath = path.join(huskyDir, 'pre-commit');

  if (!await fs.pathExists(huskyDir)) {
    logInfo("Husky directory not found. Skipping hook setup.");
    return;
  }

  const hookContent = buildHookScript();

  if (await fs.pathExists(hookPath)) {
    logInfo("Pre-commit hook already configured. Overwriting with latest setup...");
  } else {
    logInfo("Creating new pre-commit hook...");
  }

  await fs.writeFile(hookPath, hookContent);
  await fs.chmod(hookPath, 0o755);

  const gitleaksIgnorePath = path.join(process.cwd(), '.gitleaksignore');
  await fs.writeFile(gitleaksIgnorePath, '.tools/\nsonar-project.properties\n');
  logInfo(".gitleaksignore created — excluding .tools/ and sonar-project.properties.");

  logSuccess("Pre-commit hook created with Gitleaks + SonarQube (git diff only).");
};

function buildHookScript() {
  // Fixed by Arjun:
  // 1. Removed deprecated "#!/usr/bin/env sh" and ". husky.sh" lines (Husky v9 no longer needs them)
  // 2. Fixed gitleaks command — removed unsupported --path flag,
  //    now writes staged files to a temp dir and scans using --source
  return `#!/bin/sh

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "No changed files detected. Skipping checks."
  exit 0
fi

echo "[Git Diff] Changed files in this commit:"
echo "$STAGED_FILES" | while IFS= read -r FILE; do
  echo "  -> $FILE"
done

echo ""
echo "[Gitleaks] Scanning changed files for secrets..."

GITLEAKS_BIN="./.tools/gitleaks/gitleaks"

if [ ! -f "$GITLEAKS_BIN" ]; then
  echo "[Gitleaks] Binary not found. Skipping."
else
  GITLEAKS_TMPDIR=$(mktemp -d)

  echo "$STAGED_FILES" | while IFS= read -r FILE; do
    case "$FILE" in
      sonar-project.properties) ;;
      .tools/*) ;;
      *)
        if [ -f "$FILE" ]; then
          DEST="$GITLEAKS_TMPDIR/$FILE"
          mkdir -p "$(dirname "$DEST")"
          cp "$FILE" "$DEST"
        fi
        ;;
    esac
  done

  $GITLEAKS_BIN detect --source "$GITLEAKS_TMPDIR" --no-git --verbose
  GITLEAKS_EXIT=$?
  rm -rf "$GITLEAKS_TMPDIR"

  if [ $GITLEAKS_EXIT -ne 0 ]; then
    echo "[Gitleaks] Secrets detected! Commit blocked."
    exit 1
  fi

  echo "[Gitleaks] No secrets found."
fi

echo ""
echo "[SonarQube] Scanning changed files..."

# Robust detection of sonar-scanner (local bin, global command, or npx fallback)
if [ -f "./node_modules/.bin/sonar-scanner" ]; then
  SONAR_BIN="./node_modules/.bin/sonar-scanner"
elif command -v sonar-scanner >/dev/null 2>&1; then
  SONAR_BIN="sonar-scanner"
elif npx --no-install sonar-scanner --version >/dev/null 2>&1; then
  SONAR_BIN="npx --no-install sonar-scanner"
else
  SONAR_BIN=""
fi

if [ -z "$SONAR_BIN" ]; then
  echo "[SonarQube] sonar-scanner not found. Please run 'npm install' or install it globally. Skipping."
else
  if [ ! -f "sonar-project.properties" ]; then
    echo "[SonarQube] sonar-project.properties not found. Skipping."
  else
    SONAR_INCLUSIONS=$(echo "$STAGED_FILES" | tr '\n' ',' | sed 's/,$//')
    echo "[SonarQube] Scanning: $SONAR_INCLUSIONS"

    $SONAR_BIN -Dsonar.inclusions="$SONAR_INCLUSIONS"
    SONAR_EXIT=$?

    if [ $SONAR_EXIT -ne 0 ]; then
      echo "[SonarQube] Analysis failed. Commit blocked."
      exit 1
    fi
  fi
fi

exit 0
`;
}
