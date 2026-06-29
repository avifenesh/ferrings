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
const cliBin = fs.readFileSync(path.join(repoRoot, 'bin', 'ferrings.js'), 'utf8');
const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
const nvmrc = fs.readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
const nodeVersion = fs.readFileSync(path.join(repoRoot, '.node-version'), 'utf8').trim();
const SUPPORTED_NODE_ENGINES = '>=22 <23 || >=24 <25 || >=26 <27';
const DEVELOPMENT_NODE_MAJOR = '26';

const cargoVersion = matchVersion(cargoToml, /^version = "([^"]+)"/m, 'Cargo.toml package version');
const unsafeOpLint = matchVersion(
  cargoToml,
  /^\[lints\.rust\][\s\S]*?^unsafe_op_in_unsafe_fn = "([^"]+)"/m,
  'Cargo.toml unsafe_op_in_unsafe_fn lint'
);
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
assert.equal(unsafeOpLint, 'deny', 'Cargo.toml must deny unsafe_op_in_unsafe_fn');
assert.deepEqual(rootPackage.os, ['linux']);
assert.deepEqual(rootPackage.cpu, ['x64', 'arm64'], 'root package cpu must match supported native package CPUs');
assert.deepEqual(rootPackage.libc, ['glibc', 'musl'], 'root package libc must match supported native package libcs');
assert.deepEqual(
  rootPackage.engines,
  { node: SUPPORTED_NODE_ENGINES },
  'root package engines must match tested supported Node release lines'
);
assert.equal(nvmrc, DEVELOPMENT_NODE_MAJOR, '.nvmrc must pin the development Node major');
assert.equal(
  nodeVersion,
  DEVELOPMENT_NODE_MAJOR,
  '.node-version must pin the development Node major'
);
assertExportsSurface(rootPackage);
assert.equal(rootPackage.homepage, `${repositoryHttpUrl(rootPackage.repository.url)}#readme`);
assert.equal(rootPackage.bugs.url, `${repositoryHttpUrl(rootPackage.repository.url)}/issues`);
assert.equal(rootPackage.files.includes('CHANGELOG.md'), true);
assert.equal(rootPackage.files.includes('CONTRIBUTING.md'), true);
assert.equal(rootPackage.files.includes('CODE_OF_CONDUCT.md'), true);
assert.equal(rootPackage.files.includes('SECURITY.md'), true);
assert.equal(rootPackage.files.includes('index.mjs'), true);
assert.equal(rootPackage.files.includes('index.d.mts'), true);
assert.equal(rootPackage.files.includes('native.mjs'), true);
assert.equal(rootPackage.files.includes('native.d.mts'), true);
assert.equal(rootPackage.files.includes('tcp-transport.d.ts'), true);
assert.equal(rootPackage.files.includes('tcp-transport.d.mts'), true);
assert.equal(rootPackage.files.includes('zcrx-smoke.d.ts'), true);
assert.equal(rootPackage.files.includes('zcrx-smoke.d.mts'), true);
assert.equal(rootPackage.files.includes('docs/'), true);
assert.equal(
  fs.existsSync(path.join(repoRoot, 'docs', 'production.md')),
  true,
  'docs/production.md must exist'
);
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
const readmePackageVersions = [...readme.matchAll(/`ferrings@([^`]+)`/g)].map((match) => match[1]);
assert.ok(readmePackageVersions.length > 0, 'README must include at least one ferrings@version package claim');
for (const version of readmePackageVersions) {
  assert.equal(
    version,
    rootPackage.version,
    `README ferrings version mention ${version} must match package version ${rootPackage.version}`
  );
}
assertReadmePositioning(readme);
assertNoExperimentalPublicFraming(readme, 'README');
assertNoExperimentalPublicFraming(changelog, 'CHANGELOG');
assertNoExperimentalPublicFraming(rootPackage.description || '', 'package description');
assertNoExperimentalPublicFraming(cliBin, 'CLI help');
assertNoProofyCliFraming(cliBin);
assertNoLegacyQuickBenchmarkFraming(readme, changelog, rootPackage);
assertBenchmarkPublicSurface(rootPackage);
assertReadmeNodeSupport(readme);

for (const [name, version] of Object.entries(rootPackage.optionalDependencies)) {
  assert.equal(version, rootPackage.version, `${name} must match root package version`);
  assert.match(
    nativeLoader,
    new RegExp(`require\\('${escapeRegExp(name)}'\\)`),
    `native.js must include optional native package fallback ${name}`
  );
  assertLockfileOptionalNativePackage(name);
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

function assertLockfileOptionalNativePackage(name) {
  const target = name.replace(/^ferrings-/, '');
  const nativePackage = readJson(path.join(repoRoot, 'npm', target, 'package.json'));
  const locked = lock.packages[`node_modules/${name}`];
  assert.ok(locked, `package-lock must include optional native package ${name}`);
  assert.equal(locked.version, rootPackage.version, `${name} lockfile version must match root version`);
  assert.equal(locked.optional, true, `${name} lockfile entry must be optional`);
  assert.deepEqual(locked.os, nativePackage.os, `${name} lockfile os must match native package`);
  assert.deepEqual(locked.cpu, nativePackage.cpu, `${name} lockfile cpu must match native package`);
  assert.deepEqual(locked.libc, nativePackage.libc, `${name} lockfile libc must match native package`);
  assert.deepEqual(
    locked.engines,
    rootPackage.engines,
    `${name} lockfile engines must match root package engines`
  );
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
  assert.match(
    content,
    /`ferrings` is a ready-to-use Linux `io_uring` TCP transport/,
    'README opening must present ferrings as a ready-to-use transport'
  );

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

function assertNoProofyCliFraming(content) {
  const forbidden = /\b(traffic proof|proof bundle)\b/i;
  assert.equal(
    forbidden.test(content),
    false,
    'CLI help must describe validation or benchmarks, not proof-oriented framing'
  );
}

function assertNoLegacyQuickBenchmarkFraming(readmeContent, changelogContent, packageJson) {
  const joinedScripts = Object.values(packageJson.scripts || {}).join('\n');
  const forbidden = /\bquick-proof\b/i;
  assert.equal(
    forbidden.test(`${readmeContent}\n${changelogContent}\n${joinedScripts}`),
    false,
    'public docs and package scripts must not use quick-proof naming'
  );
}

function assertBenchmarkPublicSurface(packageJson) {
  assert.equal(
    packageJson.scripts?.['bench:quick'],
    'node benchmark/quick-benchmark.js',
    'bench:quick must run the benchmark-oriented public runner'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'benchmark', 'quick-benchmark.js')),
    true,
    'benchmark/quick-benchmark.js must be shipped'
  );
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'benchmark', 'quick-proof.js')),
    false,
    'benchmark/quick-proof.js must not be restored'
  );
}

function assertReadmeNodeSupport(content) {
  assert.match(
    content,
    /\bNode\.js 22, 24, or 26\b/,
    'README must advertise the tested Node release lines'
  );
  assert.match(
    content,
    /\bNode 20, 23, and 25 are EOL and not supported\b/,
    'README must not imply EOL odd-numbered Node releases are supported'
  );
  assert.match(
    content,
    /pins Node 26 through `\.nvmrc` and `\.node-version`/,
    'README must document the local development Node pin'
  );
}

function assertExportsSurface(packageJson) {
  const expectedExports = {
    '.': {
      import: {
        types: './index.d.mts',
        default: './index.mjs'
      },
      require: {
        types: './index.d.ts',
        default: './index.js'
      },
      default: './index.js'
    },
    './native': {
      import: {
        types: './native.d.mts',
        default: './native.mjs'
      },
      require: {
        types: './native.d.ts',
        default: './native.js'
      },
      default: './native.js'
    },
    './native.js': {
      import: {
        types: './native.d.mts',
        default: './native.mjs'
      },
      require: {
        types: './native.d.ts',
        default: './native.js'
      },
      default: './native.js'
    },
    './tcp-transport': {
      import: {
        types: './tcp-transport.d.mts',
        default: './tcp-transport.js'
      },
      require: {
        types: './tcp-transport.d.ts',
        default: './tcp-transport.js'
      },
      default: './tcp-transport.js'
    },
    './tcp-transport.js': {
      import: {
        types: './tcp-transport.d.mts',
        default: './tcp-transport.js'
      },
      require: {
        types: './tcp-transport.d.ts',
        default: './tcp-transport.js'
      },
      default: './tcp-transport.js'
    },
    './zcrx-smoke': {
      import: {
        types: './zcrx-smoke.d.mts',
        default: './zcrx-smoke.js'
      },
      require: {
        types: './zcrx-smoke.d.ts',
        default: './zcrx-smoke.js'
      },
      default: './zcrx-smoke.js'
    },
    './zcrx-smoke.js': {
      import: {
        types: './zcrx-smoke.d.mts',
        default: './zcrx-smoke.js'
      },
      require: {
        types: './zcrx-smoke.d.ts',
        default: './zcrx-smoke.js'
      },
      default: './zcrx-smoke.js'
    },
    './benchmark/*': './benchmark/*.js',
    './benchmark/*.js': './benchmark/*.js',
    './examples/*': './examples/*.js',
    './examples/*.js': './examples/*.js',
    './bin/ferrings': './bin/ferrings.js',
    './bin/ferrings.js': './bin/ferrings.js',
    './package.json': './package.json'
  };

  assert.deepEqual(
    packageJson.exports,
    expectedExports,
    'package exports must define the supported public entrypoint boundary'
  );
}
