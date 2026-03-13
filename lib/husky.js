const { fileExists, readJSON, writeJSON } = require('./utils');
const { installDevDependency } = require('./packageManager');
const execa = require('execa');
const path = require('path');
const fs = require('fs-extra');
const { logInfo, logSuccess } = require('./logger');

exports.installHusky = async () => {
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = await readJSON(pkgPath);

  if (!pkg.devDependencies || !pkg.devDependencies.husky) {
    logInfo("Installing Husky...");
    await installDevDependency('husky');
    logSuccess("Added husky to devDependencies in package.json");
    logInfo("Note: Run 'npm install' later to refresh your lockfile.");
  } else {
    logInfo("Husky already in devDependencies.");
  }

  logInfo("Initializing Husky...");
  try {
    // husky v9+: use `npx husky` (not the deprecated `husky install`)
    await execa('npx', ['husky'], { stdio: 'inherit' });
  } catch (e) {
    // Fallback for older husky versions
    try {
      await execa('npx', ['husky', 'install'], { stdio: 'inherit' });
    } catch (_) {
      logInfo("Husky init skipped — will be initialized on next `npm install`.");
    }
  }

  if (!pkg.scripts) pkg.scripts = {};

  if (!pkg.scripts.prepare) {
    pkg.scripts.prepare = "husky";
    await writeJSON(pkgPath, pkg);
    logSuccess("Added prepare script.");
  }
};
