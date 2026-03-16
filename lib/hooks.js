const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

/**
 * setupPreCommitHook(gitRoot)
 *
 * gitRoot – directory that contains .git and therefore .husky/.
 *           Must be passed in; never assume it equals process.cwd().
 */
exports.setupPreCommitHook = async (gitRoot) => {
  // .husky lives at the git root, not necessarily at process.cwd()
  const huskyDir = path.join(gitRoot || process.cwd(), '.husky');
  const hookPath = path.join(huskyDir, 'pre-commit');

  if (!await fs.pathExists(huskyDir)) {
    logInfo('Husky directory not found. Skipping hook setup.');
    return;
  }

  const hookContent = buildHookScript();

  if (await fs.pathExists(hookPath)) {
    logInfo('Pre-commit hook already configured. Overwriting with latest setup...');
  } else {
    logInfo('Creating new pre-commit hook...');
  }

  await fs.writeFile(hookPath, hookContent);
  await fs.chmod(hookPath, 0o755);

  // .gitleaksignore lives at the project root (next to package.json)
  const gitleaksIgnorePath = path.join(process.cwd(), '.gitleaksignore');
  await fs.writeFile(gitleaksIgnorePath, '.tools/\nsonar-project.properties\n');
  logInfo('.gitleaksignore created — excluding .tools/ and sonar-project.properties.');

  logSuccess('Pre-commit hook created with ESLint (warn) + Gitleaks + SonarQube (git diff only).');
};

function buildHookScript() {
  // Gitleaks binary name differs on Windows
  const isWin = process.platform === 'win32';
  const gitleaksBin = isWin
    ? './.tools/gitleaks/gitleaks.exe'
    : './.tools/gitleaks/gitleaks';

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
echo "[ESLint] Linting staged JS/TS files..."

# Collect only JS/TS staged files for ESLint
LINT_FILES=$(echo "$STAGED_FILES" | grep -E '\\.(js|jsx|ts|tsx|mjs|cjs)$' || true)

if [ -z "$LINT_FILES" ]; then
  echo "[ESLint] No JS/TS files staged. Skipping."
else
  # Detect ESLint binary: local node_modules first, then global, then npx
  if [ -f "./node_modules/.bin/eslint" ]; then
    ESLINT_BIN="./node_modules/.bin/eslint"
  elif command -v eslint >/dev/null 2>&1; then
    ESLINT_BIN="eslint"
  else
    ESLINT_BIN=""
  fi

  if [ -z "$ESLINT_BIN" ]; then
    echo "[ESLint] eslint not found (run 'npm install' or install globally). Skipping."
  else
    # Run ESLint — warn only, so commit always proceeds regardless of lint result
    echo "$LINT_FILES" | xargs $ESLINT_BIN --no-eslintrc 2>/dev/null || \
    echo "$LINT_FILES" | xargs $ESLINT_BIN
    LINT_EXIT=$?

    if [ $LINT_EXIT -ne 0 ]; then
      echo "[ESLint] ⚠ Lint warnings/errors found (commit allowed — fix when possible)."
    else
      echo "[ESLint] No lint issues found. ✔"
    fi
    # Never block the commit — lint is warn-only
  fi
fi

echo ""
echo "[Gitleaks] Scanning changed files for secrets..."

GITLEAKS_BIN="${gitleaksBin}"

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
    SONAR_INCLUSIONS=$(echo "$STAGED_FILES" | tr '\\n' ',' | sed 's/,$//')
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