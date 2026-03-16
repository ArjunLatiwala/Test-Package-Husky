'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const { logInfo, logSuccess } = require('./logger');

/**
 * installDevDependency(pkg)
 *
 * 1. Writes the package to devDependencies in package.json (with "latest").
 * 2. Runs `npm install` so the package actually lands in node_modules.
 *    This is essential on CI/server environments where there is no
 *    interactive npm session running separately.
 *
 * Safe to call multiple times — skips if already present.
 */
exports.installDevDependency = async (pkg) => {
  const pkgPath = path.join(process.cwd(), 'package.json');

  if (!await fs.pathExists(pkgPath)) {
    logInfo(`No package.json found at ${process.cwd()}. Skipping devDependency: ${pkg}`);
    return;
  }

  const packageJson = await fs.readJSON(pkgPath);
  if (!packageJson.devDependencies) {
    packageJson.devDependencies = {};
  }

  const alreadyListed = !!packageJson.devDependencies[pkg];

  if (!alreadyListed) {
    packageJson.devDependencies[pkg] = 'latest';
    await fs.writeJSON(pkgPath, packageJson, { spaces: 2 });
    logSuccess(`Added ${pkg} to devDependencies in package.json`);
  } else {
    logInfo(`${pkg} is already in devDependencies.`);
  }

  // Check whether the package is already installed in node_modules.
  // We look for the package.json inside its node_modules folder as a
  // reliable cross-platform check (avoids require() resolution quirks).
  const installedMarker = path.join(process.cwd(), 'node_modules', pkg, 'package.json');

  if (await fs.pathExists(installedMarker)) {
    logInfo(`${pkg} is already installed in node_modules. Skipping npm install.`);
    return;
  }

  // Actually install so node_modules is populated — critical on servers/CI
  logInfo(`Running npm install to install ${pkg}...`);
  try {
    await execa('npm', ['install', '--save-dev', pkg], {
      stdio: 'inherit',
      cwd: process.cwd(),
      // Ensure PATH is inherited so npm can be found in all environments
      env: process.env,
    });
    logSuccess(`${pkg} installed successfully.`);
  } catch (err) {
    // Non-fatal: log and continue.  The operator can run `npm install` manually.
    logInfo(
      `npm install for ${pkg} exited with an error: ${err.message}. ` +
      "Run 'npm install' manually if the package is missing."
    );
  }
};