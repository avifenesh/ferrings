'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const packagePath = path.join(repoRoot, 'package.json');
const nativeLoaderPath = path.join(repoRoot, 'native.js');
const readmePath = path.join(repoRoot, 'README.md');

const clean = runMetadataCheck();
assert.equal(clean.status, 0, `expected clean metadata\nstdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`);
assertNoLegacyFirstSlicePublicSurface();

const originalPackage = fs.readFileSync(packagePath, 'utf8');
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
    new RegExp(`README benchmark version ${staleVersion} must match package version ${rootPackage.version}`)
  );
} finally {
  fs.writeFileSync(readmePath, originalReadme);
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
}

function runMetadataCheck() {
  return spawnSync(process.execPath, ['scripts/check-package-metadata.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
}
