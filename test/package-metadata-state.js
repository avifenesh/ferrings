'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const nativeLoaderPath = path.join(repoRoot, 'native.js');

const clean = runMetadataCheck();
assert.equal(clean.status, 0, `expected clean metadata\nstdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`);

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

console.log('package metadata state ok');

function runMetadataCheck() {
  return spawnSync(process.execPath, ['scripts/check-package-metadata.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
}
