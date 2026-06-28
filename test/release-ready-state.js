'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'check-release-ready.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-release-ready-'));
const preload = path.join(tmpDir, 'mock-spawn.js');
const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tagSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

fs.writeFileSync(
  preload,
  `
    'use strict';

    const childProcess = require('node:child_process');
    const path = require('node:path');
    const originalSpawnSync = childProcess.spawnSync;
    const rootPackage = require(path.resolve(process.cwd(), 'package.json'));

    const state = process.env.FERRINGS_TEST_PUBLICATION_STATE || 'published';
    const headSha = process.env.FERRINGS_TEST_HEAD_SHA || '${headSha}';
    const tagSha = process.env.FERRINGS_TEST_TAG_SHA || '${tagSha}';

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'git') {
        return git(commandArgs);
      }
      if (command === process.execPath) {
        return node(commandArgs);
      }
      if (command === 'npm' && commandArgs[0] === 'publish') {
        return state === 'available'
          ? done(0, '[{"filename":"ferrings.tgz"}]\\n')
          : done(70, '', 'npm publish dry-run should not run for non-available versions\\n');
      }
      if (command === 'gh') {
        return done(0, '[{"name":"NPM_TOKEN"}]\\n');
      }
      return originalSpawnSync(command, args, options);
    };

    function git(args) {
      const joined = args.join(' ');
      if (joined === 'status --porcelain --untracked-files=normal') {
        return done(0, '');
      }
      if (joined.startsWith('rev-parse -q --verify refs/tags/')) {
        return done(0, tagSha + '\\n');
      }
      if (joined === 'rev-parse HEAD') {
        return done(0, headSha + '\\n');
      }
      if (joined.startsWith('rev-list -n 1 v')) {
        return done(0, tagSha + '\\n');
      }
      if (joined === 'config --get remote.origin.url') {
        return done(0, 'https://github.com/avifenesh/ferrings.git\\n');
      }
      return done(0, '');
    }

    function node(args) {
      const target = args[0] || '';
      if (target === 'scripts/check-release-publication-state.js') {
        const report = {
          package: rootPackage.name,
          version: rootPackage.version,
          expectedTag: 'latest',
          state,
          availability: [],
          published: state === 'published' ? { ok: true, errors: [] } : null,
          errors: state === 'conflict' ? ['registry mismatch'] : []
        };
        return done(state === 'conflict' ? 1 : 0, JSON.stringify(report) + '\\n');
      }
      if (target.startsWith('scripts/') || target.startsWith('test/')) {
        return done(0, target + ' ok\\n');
      }
      return originalSpawnSync(process.execPath, args);
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
  const published = runScenario('published');
  assert.equal(published.status, 'failed');
  assert.equal(check(published, `tag v${rootPackage.version} points at HEAD`).ok, false);
  assert.match(
    check(published, `tag v${rootPackage.version} points at HEAD`).detail,
    /already published and verified/
  );
  assert.match(
    check(published, `tag v${rootPackage.version} points at HEAD`).next,
    /bump package\.json/
  );
  assert.equal(check(published, 'npm publication state').ok, false);
  assert.equal(check(published, 'npm publish dry-run').ok, true);
  assert.match(check(published, 'npm publish dry-run').detail, /skipped because/);

  const available = runScenario('available');
  assert.equal(available.status, 'failed');
  assert.equal(check(available, 'npm publication state').ok, true);
  assert.match(
    check(available, `tag v${rootPackage.version} points at HEAD`).next,
    /git tag -f -a/
  );
  assert.equal(check(available, 'npm publish dry-run').ok, true);
  assert.equal(check(available, 'npm publish dry-run').detail, 'publish tarball dry-run ok');

  const conflict = runScenario('conflict');
  assert.equal(conflict.status, 'failed');
  assert.equal(check(conflict, 'npm publication state').ok, false);
  assert.match(check(conflict, 'npm publication state').detail, /registry mismatch/);
  assert.match(
    check(conflict, `tag v${rootPackage.version} points at HEAD`).detail,
    /publication state is conflict/
  );
  assert.doesNotMatch(
    check(conflict, `tag v${rootPackage.version} points at HEAD`).next,
    /git tag -f/
  );
  assert.equal(check(conflict, 'npm publish dry-run').ok, true);
  assert.match(check(conflict, 'npm publish dry-run').detail, /skipped because/);

  console.log('release-ready state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runScenario(state) {
  const result = spawnSync(process.execPath, ['--require', preload, script, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FERRINGS_TEST_PUBLICATION_STATE: state,
      FERRINGS_TEST_HEAD_SHA: headSha,
      FERRINGS_TEST_TAG_SHA: tagSha
    },
    maxBuffer: 5 * 1024 * 1024
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    1,
    `expected failed readiness for ${state}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

function check(report, name) {
  const result = report.results.find((entry) => entry.name === name);
  assert.ok(result, `missing check ${name}`);
  return result;
}
