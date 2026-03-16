const { fileExists, readJSON, writeJSON } = require('./utils');
const { installDevDependency } = require('./packageManager');
const execa = require('execa');
const path = require('path');
const fs = require('fs-extra');
const { logInfo, logSuccess } = require('./logger');

/**
 * installHusky(gitRoot)
 *
 * gitRoot – the directory that contains .git (may differ from process.cwd()
 *           in monorepos / CI checkouts).  Husky MUST be initialised there so
 *           the hooks are placed in the correct .husky directory.
 */
exports.installHusky = async (gitRoot) => {
  // Always use the project root (package.json location) for dependency management
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = await readJSON(pkgPath);

  if (!pkg.devDependencies || !pkg.devDependencies.husky) {
    logInfo('Installing Husky...');
    await installDevDependency('husky');
    logSuccess('Added husky to devDependencies in package.json');
    logInfo("Note: Run 'npm install' later to refresh your lockfile.");
  } else {
    logInfo('Husky already in devDependencies.');
  }

  logInfo('Initializing Husky...');

  // execaOptions: run from gitRoot so husky creates .husky/ in the right place.
  // On CI servers INIT_CWD / npm_config_local_prefix may differ from gitRoot.
  const execaOptions = { stdio: 'inherit', cwd: gitRoot || process.cwd() };

  try {
    // husky v9+: `npx husky` (no subcommand)
    await execa('npx', ['husky'], execaOptions);
  } catch (e) {
    // Fallback for older husky versions
    try {
      await execa('npx', ['husky', 'install'], execaOptions);
    } catch (_) {
      logInfo("Husky init skipped — will be initialised on next `npm install`.");
    }
  }

  if (!pkg.scripts) pkg.scripts = {};

  if (!pkg.scripts.prepare) {
    pkg.scripts.prepare = 'husky';
    await writeJSON(pkgPath, pkg);
    logSuccess('Added prepare script.');
  }
};