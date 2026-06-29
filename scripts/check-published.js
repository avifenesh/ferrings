'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const noTag = args.includes('--no-tag');
const requireProvenance = !args.includes('--no-provenance');
const verifyTarballs = args.includes('--verify-tarballs');
const version = valueAfter('--version') || rootPackage.version;
const expectedTag =
  valueAfter('--tag') || (version.includes('-') ? 'next' : 'latest');
const retries = positiveInteger(
  valueAfter('--retries') || process.env.FERRINGS_PUBLISH_CHECK_RETRIES || '1',
  'retries'
);
const retryDelayMs = nonNegativeInteger(
  valueAfter('--retry-delay-ms') || process.env.FERRINGS_PUBLISH_CHECK_RETRY_DELAY_MS || '0',
  'retry-delay-ms'
);

const TARGETS = [
  {
    package: 'ferrings-linux-x64-gnu',
    platform: 'linux-x64-gnu',
    main: 'ferrings.linux-x64-gnu.node',
    cpu: ['x64'],
    libc: ['glibc']
  },
  {
    package: 'ferrings-linux-x64-musl',
    platform: 'linux-x64-musl',
    main: 'ferrings.linux-x64-musl.node',
    cpu: ['x64'],
    libc: ['musl']
  },
  {
    package: 'ferrings-linux-arm64-gnu',
    platform: 'linux-arm64-gnu',
    main: 'ferrings.linux-arm64-gnu.node',
    cpu: ['arm64'],
    libc: ['glibc']
  },
  {
    package: 'ferrings-linux-arm64-musl',
    platform: 'linux-arm64-musl',
    main: 'ferrings.linux-arm64-musl.node',
    cpu: ['arm64'],
    libc: ['musl']
  }
];

const PACKAGE_FIELDS = [
  'name',
  'version',
  'description',
  'keywords',
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
  'dist.integrity',
  'dist.tarball',
  'dist.attestations',
  'dist.signatures'
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
    `published package metadata ok (${rootPackage.name}@${version}, ${
      noTag ? 'dist-tag skipped' : `tag ${expectedTag}`
    }, ${TARGETS.length} native packages${verifyTarballs ? ', tarballs verified' : ''})`
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
  const verifiedTarballs = [];
  const root = npmViewPackage(rootPackage.name, version, errors);

  if (root) {
    verifyRootPackage(root, errors);
    verified.push(rootPackage.name);
    if (verifyTarballs) {
      verifyRootTarball(errors);
      verifiedTarballs.push(rootPackage.name);
    }
  }

  if (!noTag) {
    const tags = npmViewDistTags(rootPackage.name, errors);
    if (tags) {
      if (tags[expectedTag] !== version) {
        errors.push(
          `${rootPackage.name} dist-tag ${expectedTag} points at ` +
            `${tags[expectedTag] || '(missing)'}, expected ${version}`
        );
      }
    }
  }

  for (const target of TARGETS) {
    const published = npmViewPackage(target.package, version, errors);
    if (!published) continue;
    verifyNativePackage(published, target, errors);
    verified.push(target.package);
    if (verifyTarballs) {
      verifyNativeTarball(target, errors);
      verifiedTarballs.push(target.package);
    }
  }

  return {
    package: rootPackage.name,
    version,
    expectedTag: noTag ? null : expectedTag,
    requireProvenance,
    verifyTarballs,
    ok: errors.length === 0,
    errors,
    verified,
    verifiedTarballs
  };
}

function verifyRootPackage(published, errors) {
  expectEqual(published, 'name', rootPackage.name, errors);
  expectEqual(published, 'version', version, errors);
  expectEqual(published, 'description', rootPackage.description, errors);
  expectEqual(published, 'keywords', rootPackage.keywords, errors);
  expectEqual(published, 'license', rootPackage.license, errors);
  expectEqual(published, 'main', rootPackage.main, errors);
  expectEqual(published, 'bin', rootPackage.bin, errors);
  expectEqual(published, 'engines', rootPackage.engines, errors);
  expectEqual(published, 'os', rootPackage.os, errors);
  expectEqual(published, 'cpu', rootPackage.cpu, errors);
  expectEqual(published, 'libc', rootPackage.libc, errors);
  expectEqual(published, 'optionalDependencies', rootPackage.optionalDependencies, errors);
  expectEqual(published, 'repository.url', rootPackage.repository.url, errors);
  expectEqual(published, 'homepage', rootPackage.homepage, errors);
  expectEqual(published, 'bugs.url', rootPackage.bugs.url, errors);
  expectPresent(published, 'dist.integrity', errors);
  expectPresent(published, 'dist.tarball', errors);
  if (requireProvenance) {
    expectProvenance(published, errors);
  }
}

function verifyNativePackage(published, target, errors) {
  expectEqual(published, 'name', target.package, errors);
  expectEqual(published, 'version', version, errors);
  expectEqual(published, 'description', `Native ferrings binding for ${target.platform}`, errors);
  expectEqual(published, 'keywords', rootPackage.keywords, errors);
  expectEqual(published, 'license', rootPackage.license, errors);
  expectEqual(published, 'main', target.main, errors);
  expectEqual(published, 'engines', rootPackage.engines, errors);
  expectEqual(published, 'os', ['linux'], errors);
  expectEqual(published, 'cpu', target.cpu, errors);
  expectEqual(published, 'libc', target.libc, errors);
  expectEqual(published, 'repository.url', rootPackage.repository.url, errors);
  expectEqual(published, 'homepage', rootPackage.homepage, errors);
  expectEqual(published, 'bugs.url', rootPackage.bugs.url, errors);
  expectPresent(published, 'dist.integrity', errors);
  expectPresent(published, 'dist.tarball', errors);
  if (requireProvenance) {
    expectProvenance(published, errors);
  }
}

function verifyRootTarball(errors) {
  const pack = npmPackPackage(rootPackage.name, errors);
  if (!pack) return;
  expectEqual(pack, 'name', rootPackage.name, errors);
  expectEqual(pack, 'version', version, errors);
  const files = packFileSet(pack, rootPackage.name, errors);
  if (!files) return;

  for (const filePath of [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    'docs/production.md',
    'LICENSE-APACHE',
    'LICENSE-MIT',
    'index.js',
    'index.d.ts',
    'native.js',
    'native.d.ts',
    'tcp-transport.js',
    'zcrx-smoke.js',
    'bin/ferrings.js',
    'benchmark/compare.js',
    'benchmark/quick-benchmark.js',
    'benchmark/high-concurrency.js',
    'benchmark/syscalls.js',
    'benchmark/tcp-echo.js',
    'examples/http-fixed.js',
    'examples/tcp-echo.js'
  ]) {
    expectFile(files, rootPackage.name, filePath, errors);
  }

  expectNoNativeFiles(files, rootPackage.name, errors);
  for (const filePath of ['src/lib.rs', 'src/uring.rs', 'test/smoke.js']) {
    expectNoFile(files, rootPackage.name, filePath, errors);
  }
}

function verifyNativeTarball(target, errors) {
  const pack = npmPackPackage(target.package, errors);
  if (!pack) return;
  expectEqual(pack, 'name', target.package, errors);
  expectEqual(pack, 'version', version, errors);
  const files = packFileSet(pack, target.package, errors);
  if (!files) return;

  for (const filePath of ['package.json', target.main, 'LICENSE-APACHE', 'LICENSE-MIT']) {
    expectFile(files, target.package, filePath, errors);
  }
  expectNoFile(files, target.package, 'README.md', errors);
  expectNoFile(files, target.package, 'src/uring.rs', errors);
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

function npmPackPackage(name, errors) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-published-pack-'));
  try {
    const result = spawnSync(
      'npm',
      ['pack', `${name}@${version}`, '--json', '--pack-destination', tmpDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      }
    );
    if (result.status !== 0) {
      errors.push(`${name}@${version} tarball could not be packed: ${npmFailure(result)}`);
      return null;
    }
    const packs = parseJson(result.stdout, `${name}@${version} npm pack output`, errors);
    if (!Array.isArray(packs) || packs.length !== 1) {
      errors.push(`${name}@${version} npm pack returned ${JSON.stringify(packs)}`);
      return null;
    }
    return packs[0];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
    errors.push(
      `${fieldValue(record, 'name') || 'package'} ${field} was ` +
        `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
  }
}

function expectPresent(record, field, errors) {
  const value = fieldValue(record, field);
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${fieldValue(record, 'name') || 'package'} ${field} is missing`);
  }
}

function packFileSet(pack, packageName, errors) {
  if (!Array.isArray(pack.files)) {
    errors.push(`${packageName} tarball file list is missing`);
    return null;
  }
  return new Set(pack.files.map((file) => file.path));
}

function expectFile(files, packageName, filePath, errors) {
  if (!files.has(filePath)) {
    errors.push(`${packageName} tarball is missing ${filePath}`);
  }
}

function expectNoFile(files, packageName, filePath, errors) {
  if (files.has(filePath)) {
    errors.push(`${packageName} tarball unexpectedly includes ${filePath}`);
  }
}

function expectNoNativeFiles(files, packageName, errors) {
  for (const filePath of files) {
    if (filePath.endsWith('.node')) {
      errors.push(`${packageName} tarball unexpectedly includes native binary ${filePath}`);
    }
  }
}

function expectProvenance(record, errors) {
  const packageName = fieldValue(record, 'name') || 'package';
  const attestations = fieldValue(record, 'dist.attestations');
  const signatures = fieldValue(record, 'dist.signatures');
  const predicateType = attestations?.provenance?.predicateType;

  if (typeof attestations?.url !== 'string' || attestations.url.length === 0) {
    errors.push(`${packageName} dist.attestations.url is missing`);
  }
  if (predicateType !== 'https://slsa.dev/provenance/v1') {
    errors.push(
      `${packageName} dist.attestations.provenance.predicateType was ` +
        `${JSON.stringify(predicateType)}, expected "https://slsa.dev/provenance/v1"`
    );
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    errors.push(`${packageName} dist.signatures is missing`);
    return;
  }
  for (const [index, signature] of signatures.entries()) {
    if (typeof signature?.keyid !== 'string' || signature.keyid.length === 0) {
      errors.push(`${packageName} dist.signatures[${index}].keyid is missing`);
    }
    if (typeof signature?.sig !== 'string' || signature.sig.length === 0) {
      errors.push(`${packageName} dist.signatures[${index}].sig is missing`);
    }
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
