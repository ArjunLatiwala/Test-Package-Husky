'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { logInfo, logSuccess, logError } = require('./logger');

/**
 * installDevDependency(pkg)
 *
 * Installs a package into node_modules AND records it in devDependencies.
 * Uses `npm install --save-dev` as the single source of truth — this both
 * downloads the package AND writes package.json in one step, which is the
 * only reliable way to ensure the binary lands in node_modules on a fresh
 * machine / CI server.
 *
 * Safe to call multiple times — skips if already installed in node_modules.
 */
exports.installDevDependency = async (pkg) => {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!await fs.pathExists(pkgPath)) {
    logInfo(`No package.json found at ${process.cwd()}. Skipping devDependency: ${pkg}`);
    return;
  }

  // Check whether the package is already physically installed in node_modules.
  // This is the definitive check — if the binary is there, we are done.
  const installedMarker = path.join(process.cwd(), 'node_modules', pkg, 'package.json');

  if (await fs.pathExists(installedMarker)) {
    logInfo(`${pkg} is already installed in node_modules. Skipping.`);
    return;
  }

  // Run `npm install --save-dev <pkg>` — this installs into node_modules AND
  // updates package.json devDependencies atomically. This is the correct approach
  // for fresh machines / CI where node_modules does not yet exist.
  logInfo(`Installing ${pkg} (npm install --save-dev)...`);
  try {
    await execa('npm', ['install', '--save-dev', pkg], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
    });
    logSuccess(`${pkg} installed successfully into node_modules.`);
  } catch (err) {
    // Log clearly so the user knows exactly what to do next
    logError(
      `Failed to install ${pkg}: ${err.message}\n` +
      `  → Please run manually: npm install --save-dev ${pkg}`
    );
  }
};