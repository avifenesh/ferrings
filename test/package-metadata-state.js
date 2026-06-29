'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const packagePath = path.join(repoRoot, 'package.json');
const lockPath = path.join(repoRoot, 'package-lock.json');
const cargoTomlPath = path.join(repoRoot, 'Cargo.toml');
const nativeLoaderPath = path.join(repoRoot, 'native.js');
const readmePath = path.join(repoRoot, 'README.md');
const cliPath = path.join(repoRoot, 'bin', 'ferrings.js');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

const clean = runMetadataCheck();
assert.equal(clean.status, 0, `expected clean metadata\nstdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`);
assertNoLegacyFirstSlicePublicSurface();

const originalPackage = fs.readFileSync(packagePath, 'utf8');
const originalLock = fs.readFileSync(lockPath, 'utf8');
try {
  const packageJson = JSON.parse(originalPackage);
  packageJson.cpu = ['x64'];
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for missing root CPU selectors');
  assert.match(stale.stderr, /root package cpu must match supported native package CPUs/);
} finally {
  fs.writeFileSync(packagePath, originalPackage);
}

try {
  const packageJson = JSON.parse(originalPackage);
  packageJson.engines = { node: '>=22' };
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for broad Node engines');
  assert.match(stale.stderr, /root package engines must match tested supported Node release lines/);
} finally {
  fs.writeFileSync(packagePath, originalPackage);
}

try {
  const packageJson = JSON.parse(originalPackage);
  delete packageJson.exports;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when package exports are removed');
  assert.match(stale.stderr, /package exports must define the supported public entrypoint boundary/);
} finally {
  fs.writeFileSync(packagePath, originalPackage);
}

try {
  const packageJson = JSON.parse(originalPackage);
  packageJson.scripts['bench:quick'] = 'node benchmark/quick-proof.js';
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for legacy quick benchmark naming');
  assert.match(stale.stderr, /public docs and package scripts must not use quick-proof naming/);
} finally {
  fs.writeFileSync(packagePath, originalPackage);
}

try {
  const lockJson = JSON.parse(originalLock);
  delete lockJson.packages['node_modules/ferrings-linux-x64-gnu'];
  fs.writeFileSync(lockPath, `${JSON.stringify(lockJson, null, 2)}\n`);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when optional native lock entry is missing');
  assert.match(stale.stderr, /package-lock must include optional native package ferrings-linux-x64-gnu/);
} finally {
  fs.writeFileSync(lockPath, originalLock);
}


const original = fs.readFileSync(nativeLoaderPath, 'utf8');
const staleVersion = rootPackage.version === '0.0.0' ? '0.0.1' : '0.0.0';
const mutated = original.replace(
  `bindingPackageVersion !== '${rootPackage.version}'`,
  `bindingPackageVersion !== '${staleVersion}'`
);
assert.notEqual(mutated, original, 'native.js version guard mutation should apply');

try {
  fs.writeFileSync(nativeLoaderPath, mutated);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for a stale native loader version');
  assert.match(stale.stderr, new RegExp(`native\\.js expected native package version ${staleVersion}`));
} finally {
  fs.writeFileSync(nativeLoaderPath, original);
}

const originalReadme = fs.readFileSync(readmePath, 'utf8');
const staleReadme = originalReadme.replace(
  `ferrings@${rootPackage.version}`,
  `ferrings@${staleVersion}`
);
assert.notEqual(staleReadme, originalReadme, 'README benchmark version mutation should apply');

try {
  fs.writeFileSync(readmePath, staleReadme);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for a stale README benchmark version');
  assert.match(
    stale.stderr,
    new RegExp(`README ferrings version mention ${staleVersion} must match package version ${rootPackage.version}`)
  );
} finally {
  fs.writeFileSync(readmePath, originalReadme);
}

const readmeOpening =
  '`ferrings` is a ready-to-use Linux `io_uring` TCP transport for Node.js services:';
const experimentalReadme = originalReadme.replace(
  readmeOpening,
  `Experimental ${readmeOpening}`
);
assert.notEqual(experimentalReadme, originalReadme, 'README experimental framing mutation should apply');

try {
  fs.writeFileSync(readmePath, experimentalReadme);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when README presents ferrings as experimental');
  assert.match(stale.stderr, /README must not present ferrings as an experiment or prototype/);
} finally {
  fs.writeFileSync(readmePath, originalReadme);
}

const demotedBenchmarkReadme = originalReadme.replace('## Benchmarks', '## Performance Notes');
assert.notEqual(demotedBenchmarkReadme, originalReadme, 'README benchmark-first mutation should apply');

try {
  fs.writeFileSync(readmePath, demotedBenchmarkReadme);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when README no longer leads with benchmarks');
  assert.match(stale.stderr, /README Benchmarks section must be the first top-level section/);
} finally {
  fs.writeFileSync(readmePath, originalReadme);
}

const originalChangelog = fs.readFileSync(changelogPath, 'utf8');
const legacyBenchmarkChangelog = originalChangelog.replace('quick-benchmark', 'quick-proof');
assert.notEqual(
  legacyBenchmarkChangelog,
  originalChangelog,
  'CHANGELOG legacy quick benchmark mutation should apply'
);

try {
  fs.writeFileSync(changelogPath, legacyBenchmarkChangelog);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when public docs use quick-proof naming');
  assert.match(stale.stderr, /public docs and package scripts must not use quick-proof naming/);
} finally {
  fs.writeFileSync(changelogPath, originalChangelog);
}

const originalCargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const weakenedUnsafeLintCargoToml = originalCargoToml.replace(
  'unsafe_op_in_unsafe_fn = "deny"',
  'unsafe_op_in_unsafe_fn = "warn"'
);
assert.notEqual(
  weakenedUnsafeLintCargoToml,
  originalCargoToml,
  'Cargo.toml unsafe lint mutation should apply'
);

try {
  fs.writeFileSync(cargoTomlPath, weakenedUnsafeLintCargoToml);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail for weakened unsafe lint policy');
  assert.match(stale.stderr, /Cargo\.toml must deny unsafe_op_in_unsafe_fn/);
} finally {
  fs.writeFileSync(cargoTomlPath, originalCargoToml);
}

const weakenedUndocumentedUnsafeLintCargoToml = originalCargoToml.replace(
  'undocumented_unsafe_blocks = "deny"',
  'undocumented_unsafe_blocks = "warn"'
);
assert.notEqual(
  weakenedUndocumentedUnsafeLintCargoToml,
  originalCargoToml,
  'Cargo.toml undocumented unsafe lint mutation should apply'
);

try {
  fs.writeFileSync(cargoTomlPath, weakenedUndocumentedUnsafeLintCargoToml);
  const stale = runMetadataCheck();
  assert.notEqual(
    stale.status,
    0,
    'metadata check should fail for weakened undocumented unsafe lint policy'
  );
  assert.match(stale.stderr, /Cargo\.toml must deny clippy undocumented_unsafe_blocks/);
} finally {
  fs.writeFileSync(cargoTomlPath, originalCargoToml);
}

const originalCli = fs.readFileSync(cliPath, 'utf8');
const proofyCli = originalCli.replace('ZCRX traffic validation', 'ZCRX traffic proof');
assert.notEqual(proofyCli, originalCli, 'CLI proof framing mutation should apply');

try {
  fs.writeFileSync(cliPath, proofyCli);
  const stale = runMetadataCheck();
  assert.notEqual(stale.status, 0, 'metadata check should fail when CLI help uses proof framing');
  assert.match(stale.stderr, /CLI help must describe validation or benchmarks/);
} finally {
  fs.writeFileSync(cliPath, originalCli);
}

console.log('package metadata state ok');

function assertNoLegacyFirstSlicePublicSurface() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  assert.equal(
    Object.keys(packageJson.scripts || {}).includes('bench:first-slice'),
    false,
    'package scripts must not expose bench:first-slice'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'benchmark', 'first-slice.js')),
    false,
    'benchmark/first-slice.js must not be shipped'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'test', 'first-slice-benchmark.js')),
    false,
    'test/first-slice-benchmark.js must not be restored'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'benchmark', 'quick-proof.js')),
    false,
    'benchmark/quick-proof.js must not be restored'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'test', 'quick-proof-benchmark.js')),
    false,
    'test/quick-proof-benchmark.js must not be restored'
  );
}

function runMetadataCheck() {
  return spawnSync(process.execPath, ['scripts/check-package-metadata.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
}
