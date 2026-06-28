'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const json = args.includes('--json');
const full = args.includes('--full');
const checks = [];

addCommandCheck({
  name: 'tracked worktree clean',
  scope: 'local',
  command: 'git',
  args: ['status', '--porcelain', '--untracked-files=normal'],
  pass: ({ stdout }) => stdout.trim().length === 0,
  failure: ({ stdout }) => stdout.trim() || 'worktree has uncommitted changes'
});

checks.push({
  name: `tag v${rootPackage.version} points at HEAD`,
  scope: 'local',
  run: () => {
    const expected = `v${rootPackage.version}`;
    const tag = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${expected}`]);
    if (tag.status !== 0) {
      return fail(`missing ${expected} tag`);
    }
    const head = run('git', ['rev-parse', 'HEAD']);
    const taggedCommit = run('git', ['rev-list', '-n', '1', expected]);
    if (head.status !== 0 || taggedCommit.status !== 0) {
      return fail('could not resolve HEAD or release tag');
    }
    if (head.stdout.trim() !== taggedCommit.stdout.trim()) {
      return fail(`${expected} does not point at HEAD`);
    }
    return pass();
  }
});

addCommandCheck({
  name: 'native package metadata',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-native-packages.js']
});

addCommandCheck({
  name: 'npm package versions available',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-npm-names.js']
});

addCommandCheck({
  name: 'napi prepublish dry-run',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/prepublish.js', '--dry-run']
});

addCommandCheck({
  name: 'npm publish dry-run',
  scope: 'local',
  command: 'npm',
  args: ['publish', '--dry-run', '--json']
});

if (full) {
  addCommandCheck({
    name: 'platform package install smoke',
    scope: 'local',
    command: process.execPath,
    args: ['test/platform-package-install-smoke.js']
  });
  addCommandCheck({
    name: 'package install smoke',
    scope: 'local',
    command: process.execPath,
    args: ['test/package-install-smoke.js']
  });
}

checks.push({
  name: 'origin remote configured',
  scope: 'external',
  run: () => {
    const result = run('git', ['config', '--get', 'remote.origin.url']);
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return fail('missing git remote origin');
    }
    return pass(result.stdout.trim());
  }
});

addCommandCheck({
  name: 'release repository metadata',
  scope: 'external',
  command: process.execPath,
  args: ['scripts/check-release-repository.js']
});

checks.push({
  name: 'ZCRX hardware proof configured',
  scope: 'external',
  run: () => {
    if (!process.env.ZCRX_INTERFACE) {
      return fail('ZCRX_INTERFACE is not set; hardware receive proof has not run');
    }
    return pass(`ZCRX_INTERFACE=${process.env.ZCRX_INTERFACE}`);
  }
});

const results = checks.map((check) => ({ name: check.name, scope: check.scope, ...check.run() }));
const localFailures = results.filter((result) => result.scope === 'local' && !result.ok);
const externalFailures = results.filter((result) => result.scope === 'external' && !result.ok);
const failed = localFailures.length > 0 || (strict && externalFailures.length > 0);

if (json) {
  console.log(
    JSON.stringify(
      {
        package: rootPackage.name,
        version: rootPackage.version,
        strict,
        full,
        status: failed ? 'failed' : externalFailures.length > 0 ? 'external-blocked' : 'ready',
        results
      },
      null,
      2
    )
  );
} else {
  for (const result of results) {
    const marker = result.ok ? 'ok' : result.scope === 'external' && !strict ? 'blocked' : 'fail';
    const suffix = result.detail ? `: ${oneLine(result.detail)}` : '';
    console.log(`${marker} ${result.scope} ${result.name}${suffix}`);
  }
  if (externalFailures.length > 0 && !strict) {
    console.log('external blockers remain; rerun with --strict when remote, repository metadata, and ZCRX proof exist');
  }
}

process.exitCode = failed ? 1 : 0;

function addCommandCheck({ name, scope, command, args: commandArgs, pass: passFn, failure }) {
  checks.push({
    name,
    scope,
    run: () => {
      const result = run(command, commandArgs);
      const ok = passFn ? passFn(result) : result.status === 0;
      if (ok) {
        return pass(trimForDetail(result.stdout));
      }
      return fail(
        failure
          ? failure(result)
          : trimForDetail(result.stderr) || trimForDetail(result.stdout) || `${command} exited ${result.status}`
      );
    }
  });
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_dry_run: command === 'npm' && commandArgs.includes('--dry-run') ? 'true' : process.env.npm_config_dry_run
    },
    maxBuffer: 20 * 1024 * 1024
  });
}

function pass(detail = '') {
  return { ok: true, detail };
}

function fail(detail) {
  return { ok: false, detail };
}

function trimForDetail(value) {
  return (value || '').trim().split('\n').slice(-1)[0] || '';
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
