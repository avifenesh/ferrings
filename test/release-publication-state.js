'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'check-release-publication-state.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-publication-state-'));
const preload = path.join(tmpDir, 'mock-spawn.js');

fs.writeFileSync(
  preload,
  `
    'use strict';

    const childProcess = require('node:child_process');
    const path = require('node:path');
    const originalSpawnSync = childProcess.spawnSync;
    const rootPackage = require(path.resolve(process.cwd(), 'package.json'));
    const existing = new Set((process.env.FERRINGS_TEST_EXISTING_PACKAGES || '').split(',').filter(Boolean));
    const publishedOk = process.env.FERRINGS_TEST_PUBLISHED_OK === '1';

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'npm' && commandArgs[0] === 'view') {
        return npmView(commandArgs.slice(1));
      }
      if (command === process.execPath && commandArgs[0] === 'scripts/check-published.js') {
        return checkPublished();
      }
      return originalSpawnSync(command, args, options);
    };

    function npmView(args) {
      const { name, version } = parseSpec(args[0]);
      if (existing.has(name)) {
        return done(0, JSON.stringify(version) + '\\n');
      }
      return done(1, '', 'npm ERR! code E404\\n');
    }

    function checkPublished() {
      if (publishedOk) {
        return done(0, JSON.stringify({ ok: true, errors: [] }) + '\\n');
      }
      return done(1, JSON.stringify({ ok: false, errors: ['published package set incomplete'] }) + '\\n');
    }

    function parseSpec(spec) {
      const at = String(spec).lastIndexOf('@');
      return {
        name: String(spec).slice(0, at),
        version: String(spec).slice(at + 1)
      };
    }

    function done(status, stdout = '', stderr = '') {
      return {
        pid: 1,
        output: [null, stdout, stderr],
        stdout,
        stderr,
        status,
        signal: null,
        error: undefined
      };
    }
  `
);

try {
  const available = runState();
  assert.equal(available.status, 0, available.stderr);
  assert.equal(available.report.state, 'available');

  const published = runState({
    FERRINGS_TEST_EXISTING_PACKAGES: packageNames().join(','),
    FERRINGS_TEST_PUBLISHED_OK: '1'
  });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.report.state, 'published');

  const partial = runState({
    FERRINGS_TEST_EXISTING_PACKAGES: 'ferrings-linux-x64-gnu'
  });
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(partial.report.state, 'partial');
  assert.match(partial.report.errors.join('\n'), /ferrings-linux-x64-gnu@.*already exists/);
  assert.match(partial.report.errors.join('\n'), /ferrings@.*not published/);

  const conflict = runState({
    FERRINGS_TEST_EXISTING_PACKAGES: packageNames().join(',')
  });
  assert.notEqual(conflict.status, 0, 'conflicting package set should fail');
  assert.equal(conflict.report.state, 'conflict');
  assert.match(conflict.report.errors.join('\n'), /published package set incomplete/);

  console.log('release publication state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runState(env = {}) {
  const result = spawnSync(process.execPath, ['--require', preload, script, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    },
    maxBuffer: 5 * 1024 * 1024
  });
  return {
    ...result,
    report: JSON.parse(result.stdout)
  };
}

function packageNames() {
  return [rootPackage.name, ...Object.keys(rootPackage.optionalDependencies || {})];
}
