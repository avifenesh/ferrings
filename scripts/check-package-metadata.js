'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = readJson(path.join(repoRoot, 'package.json'));
const lock = readJson(path.join(repoRoot, 'package-lock.json'));
const cargoToml = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8');
const cargoLock = fs.readFileSync(path.join(repoRoot, 'Cargo.lock'), 'utf8');
const nativeLoader = fs.readFileSync(path.join(repoRoot, 'native.js'), 'utf8');

const cargoVersion = matchVersion(cargoToml, /^version = "([^"]+)"/m, 'Cargo.toml package version');
const cargoLockVersion = matchVersion(
  cargoLock,
  /\[\[package\]\]\nname = "ferrings"\nversion = "([^"]+)"/m,
  'Cargo.lock ferrings package version'
);

assert.equal(lock.name, rootPackage.name);
assert.equal(lock.version, rootPackage.version);
assert.equal(lock.packages[''].name, rootPackage.name);
assert.equal(lock.packages[''].version, rootPackage.version);
assert.equal(cargoVersion, rootPackage.version);
assert.equal(cargoLockVersion, rootPackage.version);
assert.equal(rootPackage.homepage, `${repositoryHttpUrl(rootPackage.repository.url)}#readme`);
assert.equal(rootPackage.bugs.url, `${repositoryHttpUrl(rootPackage.repository.url)}/issues`);
assert.equal(rootPackage.files.includes('CHANGELOG.md'), true);
assert.equal(rootPackage.files.includes('CONTRIBUTING.md'), true);
assert.equal(rootPackage.files.includes('CODE_OF_CONDUCT.md'), true);
assert.equal(rootPackage.files.includes('SECURITY.md'), true);

for (const [name, version] of Object.entries(rootPackage.optionalDependencies)) {
  assert.equal(version, rootPackage.version, `${name} must match root package version`);
  assert.match(
    nativeLoader,
    new RegExp(`require\\('${escapeRegExp(name)}'\\)`),
    `native.js must include optional native package fallback ${name}`
  );
}

const nativeLoaderVersions = [
  ...nativeLoader.matchAll(/bindingPackageVersion !== '([^']+)'/g),
  ...nativeLoader.matchAll(/expected ([^ ]+) but got/g)
].map((match) => match[1]);
assert.ok(nativeLoaderVersions.length > 0, 'native.js native package version checks not found');
for (const version of nativeLoaderVersions) {
  assert.equal(version, rootPackage.version, `native.js expected native package version ${version}`);
}

console.log(`package metadata ok (${rootPackage.name}@${rootPackage.version})`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function matchVersion(content, pattern, label) {
  const match = content.match(pattern);
  assert.ok(match, `${label} not found`);
  return match[1];
}

function repositoryHttpUrl(repositoryUrl) {
  return repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
