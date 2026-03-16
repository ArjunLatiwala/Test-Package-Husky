#!/usr/bin/env node
const { installHusky } = require('../lib/husky');
const { installGitleaks } = require('../lib/gitleaks');
const { installSonarScanner, setupSonarProperties } = require('../lib/sonarqube');
const { setupPreCommitHook } = require('../lib/hooks');
const { setupPrePushHook, setupCIScript, setupCIWorkflow, validateProject, ensurePackageLock } = require('../lib/ci');
const { isGitRepo } = require('../lib/git');
const { logInfo, logError, logSuccess } = require('../lib/logger');

const command = process.argv[2];

const isPostInstall = process.env.npm_lifecycle_event === 'postinstall';
const validCommands = ['init', 'install'];

if (command && !validCommands.includes(command)) {
  console.log('Usage: cs-setup [init|install]');
  process.exit(0);
}

// Resolve project directory during postinstall
if (isPostInstall) {
  const targetDir =
    process.env.INIT_CWD ||
    process.env.npm_config_local_prefix ||
    null;

  if (!targetDir) {
    logError(
      'Could not determine your project directory. ' +
      'Please run `npx cs-setup init` manually from your project root.'
    );
    process.exit(0);
  }

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

(async () => {
  try {
    logInfo('Initializing secure git hooks...');

    const { found, gitRoot, projectRoot } = await isGitRepo();

    if (!found) {
      logError('Not inside a git repository. Skipping automatic cs-setup.');
      logInfo('Please run `git init` first, then manually run: npx cs-setup init');
      process.exit(0);
    }

    if (gitRoot !== projectRoot) {
      logInfo(`Git root detected at: ${gitRoot}`);
      logInfo(`Project root (package.json): ${projectRoot}`);
      logInfo(`Monorepo/subfolder setup — hooks at git root, config at project root.`);
    }

    // Pre-commit hooks
    await installHusky(gitRoot);
    await installGitleaks();
    await installSonarScanner();
    await setupSonarProperties();
    await setupPreCommitHook(gitRoot);
    logSuccess('Secure Husky + Gitleaks + SonarQube setup completed.');
    logInfo('Next step: edit sonar-project.properties and set sonar.host.url and sonar.token.');

    // Pre-push hook + CI workflow
    logInfo('Setting up Newman & Smoke Test CI workflow...');
    await ensurePackageLock();
    await validateProject();
    await setupCIScript(gitRoot);
    await setupCIWorkflow();
    await setupPrePushHook(gitRoot);
    logSuccess('Newman + Smoke Test pre-push hook and GitHub Actions workflow setup completed.');

  } catch (err) {
    logError(err.message);
    process.exit(0);
  }
})();