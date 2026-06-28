'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const version = process.env.ACTIONLINT_VERSION || '1.7.12';
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => path.join(workflowsDir, file))
    .sort();
  assert.ok(workflowFiles.length > 0, 'no GitHub Actions workflows found');

  const actionlint = process.env.ACTIONLINT_BIN || (await ensureActionlint());
  runChecked(actionlint, ['-version']);
  runChecked(actionlint, ['-color=false', ...workflowFiles]);
  console.log(`workflow lint ok (${workflowFiles.length} workflows, actionlint ${version})`);
}

async function ensureActionlint() {
  const target = targetName();
  const cacheDir = path.join(repoRoot, '.cache', 'actionlint', `v${version}`, target);
  const binaryPath = path.join(cacheDir, 'actionlint');
  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const archiveName = `actionlint_${version}_${target}.tar.gz`;
  const baseUrl = `https://github.com/rhysd/actionlint/releases/download/v${version}`;
  const archiveUrl = `${baseUrl}/${archiveName}`;
  const checksumsUrl = `${baseUrl}/actionlint_${version}_checksums.txt`;
  const archivePath = path.join(cacheDir, archiveName);
  const extractDir = path.join(cacheDir, 'extract');

  const [archive, checksums] = await Promise.all([
    download(archiveUrl),
    download(checksumsUrl)
  ]);
  const expectedHash = checksumFor(checksums.toString('utf8'), archiveName);
  const actualHash = crypto.createHash('sha256').update(archive).digest('hex');
  assert.equal(actualHash, expectedHash, `${archiveName} checksum mismatch`);

  fs.writeFileSync(archivePath, archive);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  runChecked('tar', ['-xzf', archivePath, '-C', extractDir]);

  const extractedBinary = path.join(extractDir, 'actionlint');
  assert.equal(fs.existsSync(extractedBinary), true, 'actionlint binary missing from archive');
  fs.copyFileSync(extractedBinary, binaryPath);
  fs.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function targetName() {
  if (process.platform !== 'linux') {
    throw new Error(`unsupported actionlint bootstrap platform: ${process.platform}`);
  }
  if (process.arch === 'x64') {
    return 'linux_amd64';
  }
  if (process.arch === 'arm64') {
    return 'linux_arm64';
  }
  throw new Error(`unsupported actionlint bootstrap architecture: ${process.arch}`);
}

function checksumFor(checksums, archiveName) {
  for (const line of checksums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === archiveName) {
      return hash;
    }
  }
  throw new Error(`checksum entry missing for ${archiveName}`);
}

function download(url, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error(`too many redirects while downloading ${url}`));
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          const location = response.headers.location;
          if (!location) {
            reject(new Error(`redirect without location for ${url}`));
            return;
          }
          resolve(download(new URL(location, url).toString(), redirects + 1));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`download failed ${status} for ${url}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    throw result.error;
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited ${result.status}`);
  }
}
