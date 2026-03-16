'use strict';

const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const { logInfo, logSuccess, logError } = require('./logger');
const { installDevDependency } = require('./packageManager');

const SONAR_PROPS_FILE = 'sonar-project.properties';

// ---------------------------------------------------------------
// Default placeholder values — users must set their own
// SONAR_HOST_URL and SONAR_TOKEN in sonar-project.properties
// (or via environment variables SONAR_HOST_URL / SONAR_TOKEN).
// ---------------------------------------------------------------
const DEFAULT_SONAR_HOST = process.env.SONAR_HOST_URL || 'http://localhost:9000';
const DEFAULT_SONAR_TOKEN = process.env.SONAR_TOKEN || '';

/**
 * Attempts to auto-create the SonarQube project via its REST API.
 * Skips gracefully if the server is unreachable (CI servers, no SonarQube, etc.).
 * Never blocks installation.
 *
 * @param {string} projectKey
 * @param {string} projectName
 * @param {string} hostUrl   - full base URL, e.g. "http://sonar.mycompany.com:9000"
 * @param {string} token     - SonarQube user/project token
 */
async function ensureProjectExists(projectKey, projectName, hostUrl, token) {
  // If no token is provided we cannot authenticate — skip silently
  if (!token) {
    logInfo('SONAR_TOKEN not set — skipping automatic SonarQube project creation.');
    return;
  }

  // Parse the host URL so we can build an http.request options object
  let parsedHost;
  try {
    parsedHost = new URL(hostUrl);
  } catch (_) {
    logInfo(`SonarQube host URL "${hostUrl}" is invalid — skipping auto-creation.`);
    return;
  }

  const TIMEOUT_MS = 3000;

  const requestPromise = new Promise((resolve) => {
    const auth = Buffer.from(`${token}:`).toString('base64');
    const postData = `name=${encodeURIComponent(projectName)}&project=${encodeURIComponent(projectKey)}`;

    const useHttps = parsedHost.protocol === 'https:';
    const requestLib = useHttps ? require('https') : http;

    const options = {
      hostname: parsedHost.hostname,
      port: parsedHost.port || (useHttps ? 443 : 80),
      path: '/api/projects/create',
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: TIMEOUT_MS,
    };

    const req = requestLib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          logSuccess(`SonarQube project "${projectKey}" created automatically.`);
        } else if (res.statusCode === 400 && data.includes('already exists')) {
          logInfo(`SonarQube project "${projectKey}" already exists.`);
        } else {
          logInfo(`SonarQube project setup responded with ${res.statusCode} — continuing anyway.`);
        }
        resolve();
      });
    });

    req.on('error', () => {
      logInfo('SonarQube server unreachable (skipping auto-creation).');
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      logInfo('SonarQube connection timed out (skipping auto-creation).');
      resolve();
    });

    req.write(postData);
    req.end();
  });

  // Hard outer timeout so we NEVER hang installation regardless of OS networking
  return Promise.race([
    requestPromise,
    new Promise((resolve) =>
      setTimeout(() => {
        logInfo('Installation continuing (SonarQube check timed out)...');
        resolve();
      }, TIMEOUT_MS + 1000)
    ),
  ]);
}

exports.installSonarScanner = async () => {
  logInfo('Installing sonarqube-scanner as a dev dependency...');
  await installDevDependency('sonarqube-scanner');
  logSuccess('sonarqube-scanner installed.');
};

exports.setupSonarProperties = async () => {
  const propsPath = path.join(process.cwd(), SONAR_PROPS_FILE);

  const pkgPath = path.join(process.cwd(), 'package.json');
  let projectKey = 'my-project';
  let projectName = 'My Project';

  if (await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJSON(pkgPath);
    if (pkg.name) {
      projectKey = pkg.name.replace(/[^a-zA-Z0-9_\-.:]/g, '_');
      projectName = pkg.name;
    }
  }

  const sonarHost = DEFAULT_SONAR_HOST;
  const sonarToken = DEFAULT_SONAR_TOKEN;

  logInfo(`Setting up SonarQube project "${projectKey}"...`);

  // Only attempt auto-creation when a real token + reachable host is likely
  await ensureProjectExists(projectKey, projectName, sonarHost, sonarToken);

  // If no properties file exists yet, write a template.
  // If one already exists (user has customised it), leave it alone.
  if (await fs.pathExists(propsPath)) {
    logInfo(`${SONAR_PROPS_FILE} already exists — leaving it unchanged.`);
    logInfo('Edit sonar.host.url and sonar.login/sonar.token as needed.');
    return;
  }

  const content = `# ---------------------------------------------------------------
# SonarQube configuration — auto-generated by cs-setup
# Edit sonar.host.url and sonar.login before running analysis.
# You can also set SONAR_HOST_URL and SONAR_TOKEN as environment
# variables (recommended for CI/CD pipelines).
# ---------------------------------------------------------------
sonar.host.url=${sonarHost}
sonar.login=${sonarToken || 'REPLACE_WITH_YOUR_TOKEN'}
sonar.projectKey=${projectKey}
sonar.projectName=${projectName}
sonar.projectVersion=1.0
sonar.sources=.
sonar.sourceEncoding=UTF-8
sonar.exclusions=node_modules/**,dist/**,build/**,coverage/**,.husky/**,.tools/**
`;

  await fs.writeFile(propsPath, content);
  logSuccess(`${SONAR_PROPS_FILE} created.`);
  logInfo('Next step: set sonar.host.url and sonar.login (or use SONAR_HOST_URL / SONAR_TOKEN env vars).');
};