'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const packageArg = valueAfter('--package');
const requireBinary = args.has('--require-binary');

const TARGETS = [
  {
    target: 'x86_64-unknown-linux-gnu',
    platform: 'linux-x64-gnu',
    name: 'ferrings-linux-x64-gnu',
    main: 'ferrings.linux-x64-gnu.node',
    cpu: 'x64',
    libc: 'glibc'
  },
  {
    target: 'aarch64-unknown-linux-gnu',
    platform: 'linux-arm64-gnu',
    name: 'ferrings-linux-arm64-gnu',
    main: 'ferrings.linux-arm64-gnu.node',
    cpu: 'arm64',
    libc: 'glibc'
  },
  {
    target: 'x86_64-unknown-linux-musl',
    platform: 'linux-x64-musl',
    name: 'ferrings-linux-x64-musl',
    main: 'ferrings.linux-x64-musl.node',
    cpu: 'x64',
    libc: 'musl'
  },
  {
    target: 'aarch64-unknown-linux-musl',
    platform: 'linux-arm64-musl',
    name: 'ferrings-linux-arm64-musl',
    main: 'ferrings.linux-arm64-musl.node',
    cpu: 'arm64',
    libc: 'musl'
  }
];

const rootPackage = readJson(path.join(repoRoot, 'package.json'));
const selectedTargets = packageArg
  ? TARGETS.filter((target) => target.platform === packageArg)
  : TARGETS;

assert.ok(selectedTargets.length > 0, `unknown native package ${packageArg}`);
assert.deepEqual(rootPackage.os, ['linux']);
assert.equal(rootPackage.cpu, undefined);
assert.equal(rootPackage.libc, undefined);
assert.deepEqual(rootPackage.napi.targets, TARGETS.map((target) => target.target));
assert.equal(rootPackage.files.includes('ferrings.linux-x64-gnu.node'), true);
assert.equal(rootPackage.files.some((entry) => entry.includes('*.node')), false);
assert.deepEqual(rootPackage.publishConfig, {
  registry: 'https://registry.npmjs.org/',
  access: 'public',
  provenance: true
});
assert.equal(typeof rootPackage.repository?.url, 'string');
assert.equal(typeof rootPackage.homepage, 'string');
assert.equal(typeof rootPackage.bugs?.url, 'string');
assert.equal(rootPackage.files.includes('SECURITY.md'), true);

for (const target of TARGETS) {
  assert.equal(
    rootPackage.optionalDependencies[target.name],
    rootPackage.version,
    `${target.name} optional dependency must match root version`
  );
}

assert.deepEqual(
  Object.keys(rootPackage.optionalDependencies).sort(),
  TARGETS.map((target) => target.name).sort()
);

for (const target of selectedTargets) {
  checkPlatformPackage(target);
}

console.log(
  `native package metadata ok (${selectedTargets.map((target) => target.platform).join(', ')})`
);

function checkPlatformPackage(target) {
  const packageDir = path.join(repoRoot, 'npm', target.platform);
  const packageJson = readJson(path.join(packageDir, 'package.json'));
  assert.equal(packageJson.name, target.name);
  assert.equal(packageJson.version, rootPackage.version);
  assert.equal(packageJson.main, target.main);
  assert.deepEqual(packageJson.files, [target.main, 'LICENSE-APACHE', 'LICENSE-MIT']);
  assert.equal(packageJson.license, rootPackage.license);
  assert.deepEqual(packageJson.repository, rootPackage.repository);
  assert.equal(packageJson.homepage, rootPackage.homepage);
  assert.deepEqual(packageJson.bugs, rootPackage.bugs);
  assert.deepEqual(packageJson.os, ['linux']);
  assert.deepEqual(packageJson.cpu, [target.cpu]);
  assert.deepEqual(packageJson.libc, [target.libc]);
  assert.deepEqual(packageJson.publishConfig, rootPackage.publishConfig);

  const nativePath = path.join(packageDir, target.main);
  if (requireBinary) {
    assert.equal(fs.existsSync(nativePath), true, `${nativePath} is missing`);
    npmPackDryRun(packageDir, target);
  } else if (fs.existsSync(nativePath)) {
    npmPackDryRun(packageDir, target);
  }
}

function npmPackDryRun(packageDir, target) {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', packageDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `npm pack --dry-run failed in ${packageDir}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  const [pack] = JSON.parse(result.stdout);
  assert.equal(pack.name, target.name);
  assert.equal(pack.version, rootPackage.version);
  const files = new Set(pack.files.map((file) => file.path));
  assert.equal(files.has('package.json'), true);
  assert.equal(files.has(target.main), true);
  assert.equal(files.has('LICENSE-APACHE'), true);
  assert.equal(files.has('LICENSE-MIT'), true);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
