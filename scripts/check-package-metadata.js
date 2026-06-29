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
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

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
assert.deepEqual(rootPackage.os, ['linux']);
assert.deepEqual(rootPackage.cpu, ['x64', 'arm64'], 'root package cpu must match supported native package CPUs');
assert.deepEqual(rootPackage.libc, ['glibc', 'musl'], 'root package libc must match supported native package libcs');
assert.equal(rootPackage.homepage, `${repositoryHttpUrl(rootPackage.repository.url)}#readme`);
assert.equal(rootPackage.bugs.url, `${repositoryHttpUrl(rootPackage.repository.url)}/issues`);
assert.equal(rootPackage.files.includes('CHANGELOG.md'), true);
assert.equal(rootPackage.files.includes('CONTRIBUTING.md'), true);
assert.equal(rootPackage.files.includes('CODE_OF_CONDUCT.md'), true);
assert.equal(rootPackage.files.includes('SECURITY.md'), true);
assert.match(changelog, new RegExp(`^## ${escapeRegExp(rootPackage.version)} - `, 'm'));

const readmeBenchmarkVersion = matchVersion(
  readme,
  /Measured on [^\n]+ with `ferrings@([^`]+)`/,
  'README benchmark package version'
);
assert.equal(
  readmeBenchmarkVersion,
  rootPackage.version,
  `README benchmark version ${readmeBenchmarkVersion} must match package version ${rootPackage.version}`
);
assertReadmePositioning(readme);
assertNoExperimentalPublicFraming(readme, 'README');
assertNoExperimentalPublicFraming(rootPackage.description || '', 'package description');

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

function assertReadmePositioning(content) {
  const h2Sections = [...content.matchAll(/^## .+$/gm)].map((match) => match[0]);
  assert.equal(
    h2Sections[0],
    '## Benchmarks',
    'README Benchmarks section must be the first top-level section after the opening'
  );

  const benchmarksIndex = h2Sections.indexOf('## Benchmarks');
  const installationIndex = h2Sections.indexOf('## Installation');
  const quickStartIndex = h2Sections.indexOf('## Quick Start');
  assert.notEqual(benchmarksIndex, -1, 'README Benchmarks section not found');
  assert.notEqual(installationIndex, -1, 'README Installation section not found');
  assert.notEqual(quickStartIndex, -1, 'README Quick Start section not found');
  assert.ok(
    benchmarksIndex < installationIndex && benchmarksIndex < quickStartIndex,
    'README Benchmarks section must stay above install and quick start'
  );
}

function assertNoExperimentalPublicFraming(content, label) {
  const forbidden = /\b(experiment|experimental|prototype|proof[- ]of[- ]concept|poc)\b/i;
  assert.equal(
    forbidden.test(content),
    false,
    `${label} must not present ferrings as an experiment or prototype`
  );
}
