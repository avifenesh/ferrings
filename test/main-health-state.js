'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'check-main-health.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-main-health-'));
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
    const dirty = process.env.FERRINGS_TEST_DIRTY === '1';
    const optionalLockfileFail = process.env.FERRINGS_TEST_OPTIONAL_LOCKFILE_FAIL === '1';
    const tagExists = process.env.FERRINGS_TEST_TAG_EXISTS !== '0';
    const tagAtHead = process.env.FERRINGS_TEST_TAG_AT_HEAD === '1';
    const headSha = process.env.FERRINGS_TEST_HEAD_SHA || '${headSha}';
    const tagSha = tagAtHead ? headSha : (process.env.FERRINGS_TEST_TAG_SHA || '${tagSha}');

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'git') {
        return git(commandArgs);
      }
      if (command === process.execPath) {
        return node(commandArgs);
      }
      if (command === 'npm') {
        return npm(commandArgs);
      }
      return originalSpawnSync(command, args, options);
    };

    function git(args) {
      const joined = args.join(' ');
      if (joined === 'status --porcelain --untracked-files=normal') {
        return dirty ? done(0, ' M README.md\\n') : done(0, '');
      }
      if (joined.startsWith('rev-parse -q --verify refs/tags/')) {
        return tagExists ? done(0, tagSha + '\\n') : done(1, '', 'missing tag\\n');
      }
      if (joined === 'rev-parse HEAD') {
        return done(0, headSha + '\\n');
      }
      if (joined.startsWith('rev-list -n 1 v')) {
        return done(0, tagSha + '\\n');
      }
      if (joined.startsWith('rev-list --count v')) {
        return done(0, '2\\n');
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
      if (target === 'scripts/check-published.js') {
        return done(0, JSON.stringify({ ok: true, errors: [] }) + '\\n');
      }
      if (target.startsWith('scripts/') || target.startsWith('test/')) {
        return done(0, target + ' ok\\n');
      }
      return originalSpawnSync(process.execPath, args);
    }

    function npm(args) {
      if (args[0] === 'ci') {
        const omitsOptional = args.includes('--omit=optional');
        if (optionalLockfileFail && !omitsOptional) {
          return done(1, '', 'optional lockfile install failed\\n');
        }
        return done(0, 'lockfile ok\\n');
      }
      if (args[0] === 'publish') {
        return state === 'available'
          ? done(0, '[{"filename":"ferrings.tgz"}]\\n')
          : done(70, '', 'npm publish dry-run should not run for published versions\\n');
      }
      return originalSpawnSync('npm', args);
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
  const published = runScenario({ state: 'published' });
  assert.equal(published.statusCode, 0);
  assert.equal(published.report.status, 'healthy-post-release');
  assert.equal(check(published.report, 'npm publication state').ok, true);
  assert.equal(
    check(published.report, 'published package verification or publish dry-run').ok,
    true
  );
  assert.match(
    check(published.report, 'npm optional lockfile install plan').detail,
    /optional native packages enabled/
  );
  assert.equal(
    check(published.report, `release tag v${rootPackage.version} relation`).warning,
    true
  );

  const releasedHead = runScenario({ state: 'published', tagAtHead: true });
  assert.equal(releasedHead.statusCode, 0);
  assert.equal(releasedHead.report.status, 'healthy');
  assert.equal(
    check(releasedHead.report, `release tag v${rootPackage.version} relation`).warning,
    false
  );

  const available = runScenario({ state: 'available', tagExists: false });
  assert.equal(available.statusCode, 0);
  assert.equal(available.report.status, 'healthy-unreleased');
  assert.match(
    check(available.report, 'npm optional lockfile install plan').detail,
    /skipped because current version is not published/
  );
  assert.match(
    check(available.report, 'published package verification or publish dry-run').detail,
    /publish tarball dry-run ok/
  );

  const publishedOptionalLockfileFailure = runScenario({
    state: 'published',
    optionalLockfileFail: true
  });
  assert.equal(publishedOptionalLockfileFailure.statusCode, 1);
  assert.equal(publishedOptionalLockfileFailure.report.status, 'failed');
  assert.match(
    check(publishedOptionalLockfileFailure.report, 'npm optional lockfile install plan').detail,
    /optional lockfile install failed/
  );

  const availableOptionalLockfileFailure = runScenario({
    state: 'available',
    tagExists: false,
    optionalLockfileFail: true
  });
  assert.equal(availableOptionalLockfileFailure.statusCode, 0);
  assert.equal(availableOptionalLockfileFailure.report.status, 'healthy-unreleased');

  const conflict = runScenario({ state: 'conflict' });
  assert.equal(conflict.statusCode, 1);
  assert.equal(conflict.report.status, 'failed');
  assert.match(check(conflict.report, 'npm publication state').detail, /registry mismatch/);

  const dirty = runScenario({ state: 'published', dirty: true });
  assert.equal(dirty.statusCode, 1);
  assert.equal(dirty.report.status, 'failed');
  assert.match(check(dirty.report, 'tracked worktree clean').detail, /README/);

  const dirtyAllowed = runScenario({ state: 'published', dirty: true, allowDirty: true });
  assert.equal(dirtyAllowed.statusCode, 0);
  assert.equal(checkMaybe(dirtyAllowed.report, 'tracked worktree clean'), undefined);

  console.log('main-health state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runScenario({
  state,
  dirty = false,
  tagExists = true,
  tagAtHead = false,
  allowDirty = false,
  optionalLockfileFail = false
}) {
  const scriptArgs = ['--require', preload, script, '--json'];
  if (allowDirty) {
    scriptArgs.push('--allow-dirty');
  }
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FERRINGS_TEST_PUBLICATION_STATE: state,
      FERRINGS_TEST_DIRTY: dirty ? '1' : '0',
      FERRINGS_TEST_TAG_EXISTS: tagExists ? '1' : '0',
      FERRINGS_TEST_TAG_AT_HEAD: tagAtHead ? '1' : '0',
      FERRINGS_TEST_HEAD_SHA: headSha,
      FERRINGS_TEST_TAG_SHA: tagSha,
      FERRINGS_TEST_OPTIONAL_LOCKFILE_FAIL: optionalLockfileFail ? '1' : '0'
    },
    maxBuffer: 5 * 1024 * 1024
  });
  if (result.error) throw result.error;
  assert.match(
    result.stdout,
    /"package": "ferrings"/,
    `expected JSON output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return {
    statusCode: result.status,
    report: JSON.parse(result.stdout)
  };
}

function check(report, name) {
  const result = checkMaybe(report, name);
  assert.ok(result, `missing check ${name}`);
  return result;
}

function checkMaybe(report, name) {
  return report.results.find((entry) => entry.name === name);
}
