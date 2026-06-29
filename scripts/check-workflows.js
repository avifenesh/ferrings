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
  checkWorkflowPolicy(workflowFiles);
  console.log(`workflow lint ok (${workflowFiles.length} workflows, actionlint ${version})`);
}

function checkWorkflowPolicy(workflowFiles) {
  for (const workflowFile of workflowFiles) {
    const workflow = fs.readFileSync(workflowFile, 'utf8');
    const label = path.relative(repoRoot, workflowFile);
    assert.doesNotMatch(
      workflow,
      /uses:\s*mlugg\/setup-zig@/i,
      `${label} must use scripts/install-zig.js instead of setup-zig's Node action runtime`
    );
    assert.doesNotMatch(
      workflow,
      /ziglang\.org\/download\/\$\{?ZIG_VERSION\}?\/zig-linux/i,
      `${label} must not stream Zig release tarballs directly from ziglang.org`
    );
  }

  const securityWorkflow = readWorkflow(workflowFiles, 'security.yml');
  assert.equal(
    matchCount(securityWorkflow, /-\s+"scripts\/install-cargo-audit\.js"/g),
    2,
    'security.yml path filters must include scripts/install-cargo-audit.js'
  );
  assert.match(
    securityWorkflow,
    /run:\s+npm run install:cargo-audit/,
    'security.yml must install cargo-audit through the pinned local helper'
  );

  const releaseWorkflow = readWorkflow(workflowFiles, 'release.yml');
  const releaseHeader = releaseWorkflow.split(/^jobs:\s*$/m)[0];
  assert.match(
    releaseHeader,
    /^permissions:\n  contents: read\n/m,
    'release.yml must default to read-only contents permission'
  );
  assert.doesNotMatch(
    releaseHeader,
    /^\s+id-token:\s*write\s*$/m,
    'release.yml must grant id-token: write only on the publishing job'
  );
  assert.doesNotMatch(
    releaseHeader,
    /^\s+contents:\s*write\s*$/m,
    'release.yml must grant contents: write only on the publishing job'
  );
  assert.match(
    jobBlock(releaseWorkflow, 'validate'),
    /^    permissions:\n      contents: read\n/m,
    'release.yml validate job must be read-only'
  );
  assert.match(
    jobBlock(releaseWorkflow, 'build-native'),
    /^    permissions:\n      contents: read\n/m,
    'release.yml build-native job must be read-only'
  );
  assert.match(
    jobBlock(releaseWorkflow, 'package-and-publish'),
    /^    permissions:\n      contents: write\n      id-token: write\n/m,
    'release.yml package-and-publish job must be the only job with publish/release permissions'
  );
}

function readWorkflow(workflowFiles, name) {
  const workflowFile = workflowFiles.find((file) => path.basename(file) === name);
  assert.ok(workflowFile, `${name} workflow missing`);
  return fs.readFileSync(workflowFile, 'utf8');
}

function matchCount(input, pattern) {
  return input.match(pattern)?.length || 0;
}

function jobBlock(workflow, jobName) {
  const startPattern = new RegExp(`^  ${escapeRegex(jobName)}:\\n`, 'm');
  const match = startPattern.exec(workflow);
  assert.ok(match, `${jobName} job missing`);
  const start = match.index;
  const bodyStart = start + match[0].length;
  const nextJob = workflow.slice(bodyStart).search(/^  [A-Za-z0-9_-]+:\n/m);
  if (nextJob === -1) {
    return workflow.slice(start);
  }
  return workflow.slice(start, bodyStart + nextJob);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
