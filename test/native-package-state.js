'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const packagePath = path.join(repoRoot, 'npm', 'linux-x64-gnu', 'package.json');
const original = fs.readFileSync(packagePath, 'utf8');

const clean = runNativePackageCheck();
assert.equal(clean.status, 0, `expected clean native package metadata\nstderr:\n${clean.stderr}`);

try {
  mutatePackage((packageJson) => {
    packageJson.engines = { node: '>=20' };
  });
  const staleEngine = runNativePackageCheck();
  assert.notEqual(staleEngine.status, 0, 'native package check should fail for stale engines');
  assert.match(staleEngine.stderr, /engines must match root package engines/);
} finally {
  fs.writeFileSync(packagePath, original);
}

try {
  mutatePackage((packageJson) => {
    packageJson.keywords = packageJson.keywords.filter((keyword) => keyword !== 'networking');
  });
  const staleKeywords = runNativePackageCheck();
  assert.notEqual(staleKeywords.status, 0, 'native package check should fail for stale keywords');
  assert.match(staleKeywords.stderr, /keywords must match root package keywords/);
} finally {
  fs.writeFileSync(packagePath, original);
}

console.log('native package state ok');

function mutatePackage(mutator) {
  const packageJson = JSON.parse(original);
  mutator(packageJson);
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function runNativePackageCheck() {
  return spawnSync(process.execPath, ['scripts/check-native-packages.js', '--package', 'linux-x64-gnu'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
}
