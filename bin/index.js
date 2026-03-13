#!/usr/bin/env node
const { installHusky } = require('../lib/husky');
const { installGitleaks } = require('../lib/gitleaks');
const { installSonarScanner, setupSonarProperties } = require('../lib/sonarqube');
const { setupPreCommitHook } = require('../lib/hooks');
const { setupPrePushHook, setupCIScript, setupCIWorkflow, validateProject, ensurePackageLock } = require('../lib/ci');
const { isGitRepo } = require('../lib/git');
const { logInfo, logError, logSuccess } = require('../lib/logger');

const command = process.argv[2];

// ── Detect invocation context ────────────────────────────────────────────────
// postinstall: npm_lifecycle_event === 'postinstall'  (no CLI arg)
// manual CLI:  npx cs-setup init                      (command === 'init')
const isPostInstall = process.env.npm_lifecycle_event === 'postinstall';

const validCommands = ['init', 'install'];

// Exit early if called with an unknown command
if (command && !validCommands.includes(command)) {
  console.log('Usage: cs-setup [init|install]');
  process.exit(0);
}

// ── Resolve the user's project directory ────────────────────────────────────
// When npm runs postinstall it sets INIT_CWD to the directory where the user
// ran `npm install`.  We fall back through several env vars for older npm versions.
if (isPostInstall) {
  const targetDir =
    process.env.INIT_CWD ||            // npm 5.4+ — most reliable
    process.env.npm_config_local_prefix || // fallback
    null;

  if (!targetDir) {
    logError(
      'Could not determine your project directory. ' +
      'Please run `npx cs-setup init` manually from your project root.'
    );
    process.exit(0);
  }

  // Only chdir if we are currently inside node_modules (i.e. postinstall context)
  if (process.cwd() !== targetDir) {
    logInfo(`Switching to project directory: ${targetDir}`);
    try {
      process.chdir(targetDir);
    } catch (e) {
      logError(`Failed to switch directory: ${e.message}`);
      process.exit(0);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    logInfo('Initializing secure git hooks...');

    if (!await isGitRepo()) {
      logError('Not inside a git repository. Skipping automatic cs-setup.');
      logInfo("Please run `git init` first, then manually run: npx cs-setup init");
      process.exit(0);
    }

    // ── Pre-commit hooks ───────────────────────────────────────────────────
    await installHusky();
    await installGitleaks();
    await installSonarScanner();
    await setupSonarProperties();
    await setupPreCommitHook();
    logSuccess('Secure Husky + Gitleaks + SonarQube setup completed.');
    logInfo('Next step: edit sonar-project.properties and set sonar.host.url and sonar.token.');

    // ── Pre-push hook + CI workflow (Added by Arjun) ───────────────────────
    logInfo('Setting up Newman & Smoke Test CI workflow...');
    await ensurePackageLock();
    await validateProject();
    await setupCIScript();
    await setupCIWorkflow();
    await setupPrePushHook();
    logSuccess('Newman + Smoke Test pre-push hook and GitHub Actions workflow setup completed.');

  } catch (err) {
    logError(err.message);
    process.exit(0);
  }
})();