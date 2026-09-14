'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require('../package.json');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-artifacts-'));
const artifacts = path.join(fixture, 'artifacts');
const napi = path.join(repoRoot, 'node_modules', '.bin', 'napi');
const platforms = Object.keys(rootPackage.optionalDependencies).map((name) => name.slice('ferrings-'.length));

try {
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(rootPackage));
  fs.mkdirSync(artifacts);
  for (const platform of platforms) {
    const destination = path.join(fixture, 'npm', platform);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'npm', platform, 'package.json'), path.join(destination, 'package.json'));
  }

  const firstBinary = `ferrings.${platforms[0]}.node`;
  fs.writeFileSync(path.join(artifacts, firstBinary), 'artifact-layout-fixture');
  const partial = collect();
  assert.notEqual(partial.status, 0, 'release collection must reject an incomplete target set');
  assert.match(partial.stdout + partial.stderr, /Missing artifacts for configured targets/);
  for (const platform of platforms.slice(1)) {
    assert.ok((partial.stdout + partial.stderr).includes(`ferrings.${platform}.node`));
  }

  for (const platform of platforms.slice(1)) {
    fs.writeFileSync(path.join(artifacts, `ferrings.${platform}.node`), 'artifact-layout-fixture');
  }
  const complete = collect();
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  for (const platform of platforms) {
    const binary = `ferrings.${platform}.node`;
    assert.equal(fs.readFileSync(path.join(fixture, 'npm', platform, binary), 'utf8'), 'artifact-layout-fixture');
    assert.equal(fs.readFileSync(path.join(fixture, binary), 'utf8'), 'artifact-layout-fixture');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).napi.targets, rootPackage.napi.targets);
  console.log('native artifact completeness state ok');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

function collect() {
  return spawnSync(process.execPath, [napi, 'artifacts', '--cwd', fixture, '--output-dir', 'artifacts', '--npm-dir', 'npm'], {
    cwd: fixture,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
}
