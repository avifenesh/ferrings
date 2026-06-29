'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
const tag = valueAfter('--tag') || process.env.NPM_CONFIG_TAG || defaultTag(rootPackage.version);
const retries = numberValue('--retries', 1);
const retryDelayMs = numberValue('--retry-delay-ms', 5000);

const packages = [
  ...nativePackages(),
  {
    name: rootPackage.name,
    version: rootPackage.version,
    cwd: repoRoot,
    root: true
  }
];

for (const packageInfo of packages) {
  publishPackage(packageInfo);
}

function publishPackage(packageInfo) {
  if (!dryRun && packageExists(packageInfo.name, packageInfo.version)) {
    console.log(`${packageInfo.name}@${packageInfo.version} already exists; skipping publish`);
    return;
  }

  const publishArgs = ['publish', '--tag', tag, '--access', 'public', '--provenance'];
  if (dryRun) {
    publishArgs.push('--dry-run', '--json');
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = run('npm', publishArgs, {
      cwd: packageInfo.cwd,
      env: {
        ...process.env,
        ...(packageInfo.root ? { FERRINGS_SKIP_OPTIONAL_PUBLISH: '1' } : {})
      }
    });
    writeOutput(result);

    if (result.status === 0) {
      return;
    }

    if (!dryRun && packageExists(packageInfo.name, packageInfo.version)) {
      console.log(`${packageInfo.name}@${packageInfo.version} became visible after publish failure; continuing`);
      return;
    }

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/TLOG_CREATE_ENTRY_ERROR|equivalent entry already exists/i.test(output)) {
      throw new Error(
        `${packageInfo.name}@${packageInfo.version} hit an npm provenance transparency-log conflict ` +
          'but is not visible in the registry; bump the package version before retrying'
      );
    }

    if (attempt < retries && isRetryablePublishFailure(output)) {
      console.warn(
        `${packageInfo.name}@${packageInfo.version} publish attempt ${attempt} failed; retrying in ${retryDelayMs}ms`
      );
      sleep(retryDelayMs);
      continue;
    }

    throw new Error(`${packageInfo.name}@${packageInfo.version} publish failed with exit ${result.status}`);
  }
}

function nativePackages() {
  const npmDir = path.join(repoRoot, 'npm');
  return fs
    .readdirSync(npmDir)
    .sort()
    .map((entry) => {
      const cwd = path.join(npmDir, entry);
      const packageJson = require(path.join(cwd, 'package.json'));
      if (rootPackage.optionalDependencies?.[packageJson.name] !== rootPackage.version) {
        throw new Error(`${packageJson.name} is not a ${rootPackage.version} optional dependency`);
      }
      if (packageJson.version !== rootPackage.version) {
        throw new Error(`${packageJson.name} version ${packageJson.version} does not match ${rootPackage.version}`);
      }
      return {
        name: packageJson.name,
        version: packageJson.version,
        cwd,
        root: false
      };
    });
}

function packageExists(name, version) {
  const result = run('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: repoRoot,
    stdio: 'pipe'
  });
  if (result.status === 0) {
    return true;
  }
  if (isNpmNotFound(result)) {
    return false;
  }
  throw new Error(`could not check ${name}@${version} publication state: ${npmFailure(result)}`);
}

function isRetryablePublishFailure(output) {
  return /\b(E5\d\d|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed)\b/i.test(output);
}

function isNpmNotFound(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status !== 0 && /\bE404\b|404 Not Found|not found/i.test(output);
}

function npmFailure(result) {
  return (
    result.error?.message ||
    (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0] ||
    `command exited ${result.status}`
  );
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

function writeOutput(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultTag(version) {
  return version.includes('-') ? 'next' : 'latest';
}

function numberValue(name, fallback) {
  const value = valueAfter(name);
  if (value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}
