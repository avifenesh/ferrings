'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const noTag = args.includes('--no-tag');
const version = valueAfter('--version') || rootPackage.version;
const expectedTag =
  valueAfter('--tag') || (version.includes('-') ? 'next' : 'latest');
const retries = positiveInteger(valueAfter('--retries') || process.env.FERRINGS_PUBLISH_CHECK_RETRIES || '1', 'retries');
const retryDelayMs = nonNegativeInteger(
  valueAfter('--retry-delay-ms') || process.env.FERRINGS_PUBLISH_CHECK_RETRY_DELAY_MS || '0',
  'retry-delay-ms'
);

const TARGETS = [
  {
    package: 'ferrings-linux-x64-gnu',
    main: 'ferrings.linux-x64-gnu.node',
    cpu: ['x64'],
    libc: ['glibc']
  },
  {
    package: 'ferrings-linux-x64-musl',
    main: 'ferrings.linux-x64-musl.node',
    cpu: ['x64'],
    libc: ['musl']
  },
  {
    package: 'ferrings-linux-arm64-gnu',
    main: 'ferrings.linux-arm64-gnu.node',
    cpu: ['arm64'],
    libc: ['glibc']
  },
  {
    package: 'ferrings-linux-arm64-musl',
    main: 'ferrings.linux-arm64-musl.node',
    cpu: ['arm64'],
    libc: ['musl']
  }
];

const PACKAGE_FIELDS = [
  'name',
  'version',
  'license',
  'main',
  'bin',
  'engines',
  'os',
  'cpu',
  'libc',
  'optionalDependencies',
  'repository.url',
  'homepage',
  'bugs.url',
  'dist.integrity'
];

let report;
let lastReport;
for (let attempt = 1; attempt <= retries; attempt += 1) {
  report = runChecks();
  report.attempt = attempt;
  lastReport = report;
  if (report.ok) break;
  if (attempt < retries && retryDelayMs > 0) {
    sleep(retryDelayMs);
  }
}

if (json) {
  console.log(JSON.stringify(lastReport, null, 2));
} else if (lastReport.ok) {
  console.log(
    `published package metadata ok (${rootPackage.name}@${version}, ${noTag ? 'dist-tag skipped' : `tag ${expectedTag}`}, ${TARGETS.length} native packages)`
  );
} else {
  for (const error of lastReport.errors) {
    console.error(error);
  }
}

process.exitCode = lastReport.ok ? 0 : 1;

function runChecks() {
  const errors = [];
  const verified = [];
  const root = npmViewPackage(rootPackage.name, version, errors);

  if (root) {
    verifyRootPackage(root, errors);
    verified.push(rootPackage.name);
  }

  if (!noTag) {
    const tags = npmViewDistTags(rootPackage.name, errors);
    if (tags) {
      if (tags[expectedTag] !== version) {
        errors.push(
          `${rootPackage.name} dist-tag ${expectedTag} points at ${tags[expectedTag] || '(missing)'}, expected ${version}`
        );
      }
    }
  }

  for (const target of TARGETS) {
    const published = npmViewPackage(target.package, version, errors);
    if (!published) continue;
    verifyNativePackage(published, target, errors);
    verified.push(target.package);
  }

  return {
    package: rootPackage.name,
    version,
    expectedTag: noTag ? null : expectedTag,
    ok: errors.length === 0,
    errors,
    verified
  };
}

function verifyRootPackage(published, errors) {
  expectEqual(published, 'name', rootPackage.name, errors);
  expectEqual(published, 'version', version, errors);
  expectEqual(published, 'license', rootPackage.license, errors);
  expectEqual(published, 'main', rootPackage.main, errors);
  expectEqual(published, 'bin', rootPackage.bin, errors);
  expectEqual(published, 'engines', rootPackage.engines, errors);
  expectEqual(published, 'os', rootPackage.os, errors);
  expectEqual(published, 'optionalDependencies', rootPackage.optionalDependencies, errors);
  expectEqual(published, 'repository.url', rootPackage.repository.url, errors);
  expectEqual(published, 'homepage', rootPackage.homepage, errors);
  expectEqual(published, 'bugs.url', rootPackage.bugs.url, errors);
  expectPresent(published, 'dist.integrity', errors);
}

function verifyNativePackage(published, target, errors) {
  expectEqual(published, 'name', target.package, errors);
  expectEqual(published, 'version', version, errors);
  expectEqual(published, 'license', rootPackage.license, errors);
  expectEqual(published, 'main', target.main, errors);
  expectEqual(published, 'os', ['linux'], errors);
  expectEqual(published, 'cpu', target.cpu, errors);
  expectEqual(published, 'libc', target.libc, errors);
  expectEqual(published, 'repository.url', rootPackage.repository.url, errors);
  expectEqual(published, 'homepage', rootPackage.homepage, errors);
  expectEqual(published, 'bugs.url', rootPackage.bugs.url, errors);
  expectPresent(published, 'dist.integrity', errors);
}

function npmViewPackage(name, packageVersion, errors) {
  const result = npmView([`${name}@${packageVersion}`, ...PACKAGE_FIELDS]);
  if (result.status !== 0) {
    errors.push(`${name}@${packageVersion} is not visible on npm: ${npmFailure(result)}`);
    return null;
  }
  return parseJson(result.stdout, `${name}@${packageVersion}`, errors);
}

function npmViewDistTags(name, errors) {
  const result = npmView([name, 'dist-tags']);
  if (result.status !== 0) {
    errors.push(`${name} dist-tags are not visible on npm: ${npmFailure(result)}`);
    return null;
  }
  return parseJson(result.stdout, `${name} dist-tags`, errors);
}

function npmView(viewArgs) {
  return spawnSync('npm', ['view', ...viewArgs, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  });
}

function parseJson(output, label, errors) {
  try {
    return JSON.parse(output);
  } catch (error) {
    errors.push(`could not parse npm view JSON for ${label}: ${error.message}`);
    return null;
  }
}

function expectEqual(record, field, expected, errors) {
  const actual = fieldValue(record, field);
  try {
    assert.deepEqual(actual, expected);
  } catch {
    errors.push(`${fieldValue(record, 'name') || 'package'} ${field} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function expectPresent(record, field, errors) {
  const value = fieldValue(record, field);
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${fieldValue(record, 'name') || 'package'} ${field} is missing`);
  }
}

function fieldValue(record, field) {
  if (Object.prototype.hasOwnProperty.call(record, field)) {
    return record[field];
  }
  return field.split('.').reduce((current, key) => {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }
    return undefined;
  }, record);
}

function npmFailure(result) {
  return (
    result.error?.message ||
    (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0] ||
    `npm view exited ${result.status}`
  );
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return number;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
