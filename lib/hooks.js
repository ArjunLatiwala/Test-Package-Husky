'use strict';

const fs = require('fs-extra');
const path = require('path');
const { logInfo, logSuccess } = require('./logger');

/**
 * setupPreCommitHook(gitRoot)
 *
 * gitRoot     – directory containing .git  (where .husky/ lives)
 * process.cwd() – the Node.js project root  (where package.json / .tools / sonar-project.properties live)
 *
 * In a monorepo these two differ, e.g.:
 *   gitRoot     = /home/user/Pizza-Fleet
 *   projectRoot = /home/user/Pizza-Fleet/server
 *
 * The hook is written into gitRoot/.husky/pre-commit but must cd into
 * projectRoot before running any checks so every relative path resolves
 * correctly (node_modules, .tools, sonar-project.properties, etc.)
 */
exports.setupPreCommitHook = async (gitRoot) => {
  const projectRoot = process.cwd();
  const huskyDir = path.join(gitRoot || projectRoot, '.husky');
  const hookPath = path.join(huskyDir, 'pre-commit');

  if (!await fs.pathExists(huskyDir)) {
    logInfo('Husky directory not found. Skipping hook setup.');
    return;
  }

  // Compute the relative path from gitRoot to projectRoot so the hook
  // can cd into it regardless of where git runs the hook from.
  const relativeProjectDir = path.relative(gitRoot || projectRoot, projectRoot) || '.';

  const hookContent = buildHookScript(relativeProjectDir);

  if (await fs.pathExists(hookPath)) {
    logInfo('Pre-commit hook already configured. Overwriting with latest setup...');
  } else {
    logInfo('Creating new pre-commit hook...');
  }

  await fs.writeFile(hookPath, hookContent);
  await fs.chmod(hookPath, 0o755);

  // .gitleaksignore lives at the project root (next to package.json)
  const gitleaksIgnorePath = path.join(projectRoot, '.gitleaksignore');
  await fs.writeFile(gitleaksIgnorePath, '.tools/\nsonar-project.properties\n');
  logInfo('.gitleaksignore created — excluding .tools/ and sonar-project.properties.');

  logSuccess('Pre-commit hook created with ESLint (warn) + Gitleaks + SonarQube.');
  if (relativeProjectDir !== '.') {
    logInfo(`Monorepo detected — hook will cd into "${relativeProjectDir}" before running checks.`);
  }
};

/**
 * Build the shell script content for .husky/pre-commit.
 *
 * @param {string} relativeProjectDir  - path from git root to project root, e.g. "server" or "."
 */
function buildHookScript(relativeProjectDir) {
  const isWin = process.platform === 'win32';
  const gitleaksBin = isWin
    ? './.tools/gitleaks/gitleaks.exe'
    : './.tools/gitleaks/gitleaks';

  const isMonorepo = relativeProjectDir !== '.';

  const cdBlock = isMonorepo
    ? `
# ---------------------------------------------------------------
# Monorepo setup: cd into the project subfolder so all relative
# paths (node_modules, .tools, sonar-project.properties) resolve
# correctly.
# ---------------------------------------------------------------
HOOK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$HOOK_DIR/${relativeProjectDir}"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "[pre-commit] Project directory not found: $PROJECT_DIR — skipping checks."
  exit 0
fi

cd "$PROJECT_DIR" || exit 1
echo "[pre-commit] Working directory: $(pwd)"
`
    : '';

  const projectPrefix = isMonorepo ? `${relativeProjectDir}/` : '';

  const stripPrefixBlock = isMonorepo
    ? `
# Strip the subfolder prefix so file paths are relative to the project root
STAGED_FILES=$(echo "$ALL_STAGED" | grep "^${projectPrefix}" | sed "s|^${projectPrefix}||")
`
    : `
STAGED_FILES="$ALL_STAGED"
`;

  return `#!/bin/sh
${cdBlock}
# Collect staged files (git always returns paths relative to git root)
ALL_STAGED=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$ALL_STAGED" ]; then
  echo "No changed files detected. Skipping checks."
  exit 0
fi
${stripPrefixBlock}
if [ -z "$STAGED_FILES" ]; then
  echo "No staged files in this project directory. Skipping checks."
  exit 0
fi

echo "[Git Diff] Changed files in this commit:"
echo "$STAGED_FILES" | while IFS= read -r FILE; do
  echo "  -> $FILE"
done

# ---------------------------------------------------------------
# ESLint — warn only, never blocks commit
# ---------------------------------------------------------------
echo ""
echo "[ESLint] Linting staged JS/TS files..."

LINT_FILES=$(echo "$STAGED_FILES" | grep -E '\\.(js|jsx|ts|tsx|mjs|cjs)$' || true)

if [ -z "$LINT_FILES" ]; then
  echo "[ESLint] No JS/TS files staged. Skipping."
else
  if [ -f "./node_modules/.bin/eslint" ]; then
    ESLINT_BIN="./node_modules/.bin/eslint"
  elif command -v eslint >/dev/null 2>&1; then
    ESLINT_BIN="eslint"
  else
    ESLINT_BIN=""
  fi

  if [ -z "$ESLINT_BIN" ]; then
    echo "[ESLint] eslint not found — skipping (run 'npm install' to enable)."
  else
    echo "$LINT_FILES" | xargs $ESLINT_BIN 2>&1 || true
    echo "[ESLint] Lint check done (warn only — commit not blocked)."
  fi
fi

# ---------------------------------------------------------------
# Gitleaks — blocks commit if secrets found
# ---------------------------------------------------------------
echo ""
echo "[Gitleaks] Scanning staged files for secrets..."

GITLEAKS_BIN="${gitleaksBin}"

if [ ! -f "$GITLEAKS_BIN" ]; then
  echo "[Gitleaks] Binary not found at $GITLEAKS_BIN — skipping."
  echo "[Gitleaks] Hint: re-run 'npx cs-setup init' to reinstall Gitleaks."
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

  echo "[Gitleaks] No secrets found. ✔"
fi

# ---------------------------------------------------------------
# SonarQube — auto-installs scanner if missing, then runs analysis
# ---------------------------------------------------------------
echo ""
echo "[SonarQube] Scanning staged files..."

if [ -f "./node_modules/.bin/sonar-scanner" ]; then
  SONAR_BIN="./node_modules/.bin/sonar-scanner"
elif command -v sonar-scanner >/dev/null 2>&1; then
  SONAR_BIN="sonar-scanner"
else
  echo "[SonarQube] sonar-scanner not found — installing sonarqube-scanner locally..."
  npm install --save-dev sonarqube-scanner --quiet 2>&1 | tail -3
  if [ -f "./node_modules/.bin/sonar-scanner" ]; then
    SONAR_BIN="./node_modules/.bin/sonar-scanner"
    echo "[SonarQube] Installed successfully. ✔"
  else
    SONAR_BIN="npx sonarqube-scanner"
    echo "[SonarQube] Using npx fallback."
  fi
fi

if [ ! -f "sonar-project.properties" ]; then
  echo "[SonarQube] sonar-project.properties not found at $(pwd) — skipping."
else
  SONAR_INCLUSIONS=$(echo "$STAGED_FILES" | tr '\\n' ',' | sed 's/,$//')
  echo "[SonarQube] Scanning: $SONAR_INCLUSIONS"

  $SONAR_BIN -Dsonar.inclusions="$SONAR_INCLUSIONS"
  SONAR_EXIT=$?

  if [ $SONAR_EXIT -ne 0 ]; then
    echo "[SonarQube] Analysis failed. Commit blocked."
    exit 1
  fi

  echo "[SonarQube] Analysis passed. ✔"
fi

exit 0
`;
}