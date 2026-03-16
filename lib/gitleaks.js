'use strict';

const fs = require('fs-extra');
const path = require('path');
const execa = require('execa');
const https = require('https');
const { logInfo, logSuccess } = require('./logger');

const VERSION = '8.18.0';

/**
 * Returns the correct release asset filename + extraction method
 * for the current OS and CPU architecture.
 */
function getPlatformAsset() {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;         // 'x64' | 'arm64' | 'arm' | ...

  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
    arm: 'armv7',
  };
  const gitleaksArch = archMap[arch] || 'x64';

  if (platform === 'darwin') {
    return {
      filename: `gitleaks_${VERSION}_darwin_${gitleaksArch}.tar.gz`,
      extract: 'tar',
      binary: 'gitleaks',
    };
  }

  if (platform === 'win32') {
    return {
      filename: `gitleaks_${VERSION}_windows_${gitleaksArch}.zip`,
      extract: 'zip',
      binary: 'gitleaks.exe',
    };
  }

  // Default: Linux
  return {
    filename: `gitleaks_${VERSION}_linux_${gitleaksArch}.tar.gz`,
    extract: 'tar',
    binary: 'gitleaks',
  };
}

/**
 * Ensure common entries are present in .gitignore.
 */
async function ensureGitignoreEntries(entries) {
  const gitignorePath = path.join(process.cwd(), '.gitignore');

  let content = '';
  if (await fs.pathExists(gitignorePath)) {
    content = await fs.readFile(gitignorePath, 'utf-8');
  }

  const added = [];
  for (const entry of entries) {
    if (!content.split('\n').some((line) => line.trim() === entry.trim())) {
      content += `\n${entry}`;
      added.push(entry);
    }
  }

  if (added.length > 0) {
    await fs.writeFile(gitignorePath, content);
    logInfo(`.gitignore updated — added: ${added.join(', ')}`);
  }
}

/**
 * Extract a .tar.gz archive using the system `tar` command.
 * Works on macOS, Linux, and modern Windows 10+ (which ships tar).
 */
async function extractTar(archivePath, destDir) {
  try {
    await execa('tar', ['-xzf', archivePath, '-C', destDir]);
  } catch (err) {
    throw new Error(`tar extraction failed: ${err.message}`);
  }
}

/**
 * Extract a .zip archive.
 * - On Windows: uses PowerShell's Expand-Archive (available on all modern Windows).
 * - On Linux/macOS: uses `unzip` with a fallback to Python.
 */
async function extractZip(archivePath, destDir) {
  if (process.platform === 'win32') {
    // PowerShell is available on all Windows versions since Win7
    await execa('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -Path "${archivePath}" -DestinationPath "${destDir}"`,
    ]);
    return;
  }

  // Linux / macOS — prefer unzip, fall back to Python
  try {
    await execa('unzip', ['-o', archivePath, '-d', destDir]);
  } catch (_) {
    // Python is nearly always available as a last resort
    try {
      await execa('python3', [
        '-c',
        `import zipfile; zipfile.ZipFile('${archivePath}').extractall('${destDir}')`,
      ]);
    } catch (pyErr) {
      throw new Error(
        'Could not extract zip: `unzip` not found and Python fallback failed. ' +
        'Please install `unzip` (e.g. `apt-get install unzip` / `brew install unzip`).'
      );
    }
  }
}

exports.installGitleaks = async () => {
  const toolsDir = path.join(process.cwd(), '.tools');
  const gitleaksDir = path.join(toolsDir, 'gitleaks');

  const { filename, extract, binary } = getPlatformAsset();
  const binaryPath = path.join(gitleaksDir, binary);

  if (await fs.pathExists(binaryPath)) {
    logInfo('Gitleaks already installed locally.');
    return;
  }

  logInfo('Installing Gitleaks locally...');
  await fs.ensureDir(gitleaksDir);

  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${filename}`;
  const destPath = path.join(gitleaksDir, filename);

  logInfo(`Downloading ${filename} from GitHub...`);
  await downloadFile(url, destPath);

  logInfo(`Extracting ${filename}...`);
  if (extract === 'tar') {
    await extractTar(destPath, gitleaksDir);
  } else {
    await extractZip(destPath, gitleaksDir);
  }

  await fs.remove(destPath);

  // chmod only makes sense on POSIX; Windows ignores it harmlessly
  if (process.platform !== 'win32') {
    await fs.chmod(binaryPath, 0o755);
  }

  // Keep sensitive / large paths out of git
  await ensureGitignoreEntries(['.tools/', 'node_modules/', '.env', '.env.*', '.env.local']);

  logSuccess('Gitleaks installed locally.');
};

/**
 * Download a file from `url` to `dest`, following HTTP redirects.
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'node-cs-setup' } }, (response) => {
      // Follow redirects (GitHub release downloads redirect to S3)
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(
          new Error(
            `Download failed with HTTP ${response.statusCode}. ` +
            `Check your internet connection and that v${VERSION} exists on GitHub.`
          )
        );
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (err) => {
        fs.remove(dest).catch(() => { });
        reject(err);
      });
    });

    request.on('error', reject);
  });
}