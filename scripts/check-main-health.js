'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runtimeSupport } = require('./node-runtime');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const full = args.includes('--full');
const allowDirty = args.includes('--allow-dirty');
const expectedTag = rootPackage.version.includes('-') ? 'next' : 'latest';
const checks = [];
let publicationState = null;

if (!allowDirty) {
  addCommandCheck({
    name: 'tracked worktree clean',
    command: 'git',
    args: ['status', '--porcelain', '--untracked-files=normal'],
    pass: ({ stdout }) => stdout.trim().length === 0,
    failure: ({ stdout }) => stdout.trim() || 'worktree has uncommitted changes'
  });
}

addCommandCheck({
  name: 'package metadata consistency',
  command: process.execPath,
  args: ['scripts/check-package-metadata.js'],
  success: 'metadata versions and links ok'
});

checks.push({
  name: 'supported Node.js runtime',
  run: () => {
    const support = runtimeSupport(rootPackage);
    return support.ok ? pass(support.detail) : fail(support.detail);
  }
});

addCommandCheck({
  name: 'GitHub Actions workflow lint',
  command: process.execPath,
  args: ['scripts/check-workflows.js'],
  success: 'workflow syntax and expressions ok'
});

addCommandCheck({
  name: 'npm lockfile install plan',
  command: 'npm',
  args: ['ci', '--dry-run', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  success: 'lockfile can install without optional native packages'
});

addCommandCheck({
  name: 'native package metadata',
  command: process.execPath,
  args: ['scripts/check-native-packages.js'],
  success: 'native package metadata ok'
});

checks.push({
  name: 'npm publication state',
  run: () => {
    const result = run(process.execPath, [
      'scripts/check-release-publication-state.js',
      '--tag',
      expectedTag,
      '--json'
    ]);
    publicationState = parseJson(result.stdout);
    if (!publicationState) {
      return fail(
        trimForDetail(result.stderr) ||
          trimForDetail(result.stdout) ||
          `publication state exited ${result.status}`
      );
    }
    if (result.status !== 0 || publicationState.state === 'conflict') {
      return fail(
        publicationState.errors?.join('; ') ||
          `${rootPackage.name}@${rootPackage.version} publication state is ${
            publicationState.state || 'unknown'
          }`
      );
    }
    return pass(`${rootPackage.name}@${rootPackage.version} is ${publicationState.state}`);
  }
});

checks.push({
  name: 'npm optional lockfile install plan',
  run: () => {
    if (!publicationState) {
      return fail('publication state was not resolved');
    }
    if (publicationState.state !== 'published') {
      return pass('skipped because current version is not published');
    }
    const result = run('npm', ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
    if (result.status === 0) {
      return pass('lockfile can install with optional native packages enabled');
    }
    return fail(
      trimForDetail(result.stderr) ||
        trimForDetail(result.stdout) ||
        `npm ci exited ${result.status}`
    );
  }
});

checks.push({
  name: 'published package verification or publish dry-run',
  run: () => {
    if (!publicationState) {
      return fail('publication state was not resolved');
    }
    if (publicationState.state === 'published') {
      const result = run(process.execPath, [
        'scripts/check-published.js',
        '--tag',
        expectedTag,
        '--verify-tarballs',
        '--json'
      ]);
      const report = parseJson(result.stdout);
      if (result.status === 0 && report?.ok) {
        const tarballDetail = report.verifyTarballs ? ' and tarballs' : '';
        return pass(`published packages verified with ${expectedTag} dist-tag${tarballDetail}`);
      }
      return fail(
        report?.errors?.join('; ') ||
          trimForDetail(result.stderr) ||
          trimForDetail(result.stdout) ||
          `check-published exited ${result.status}`
      );
    }
    if (publicationState.state === 'available') {
      const result = run('npm', ['publish', '--dry-run', '--json']);
      if (result.status === 0) {
        return pass('publish tarball dry-run ok');
      }
      return fail(
        trimForDetail(result.stderr) ||
          trimForDetail(result.stdout) ||
          `npm publish exited ${result.status}`
      );
    }
    return fail(
      `${rootPackage.name}@${rootPackage.version} publication state is ${publicationState.state}`
    );
  }
});

checks.push({
  name: `release tag v${rootPackage.version} relation`,
  run: () => {
    const tagName = `v${rootPackage.version}`;
    const tag = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`]);
    if (tag.status !== 0) {
      return pass(`no ${tagName} tag yet; release-ready owns tag validation`, true);
    }

    const head = run('git', ['rev-parse', 'HEAD']);
    const taggedCommit = run('git', ['rev-list', '-n', '1', tagName]);
    if (head.status !== 0 || taggedCommit.status !== 0) {
      return fail('could not resolve HEAD or release tag');
    }

    const headSha = head.stdout.trim();
    const tagSha = taggedCommit.stdout.trim();
    if (headSha === tagSha) {
      return pass(`${tagName} points at HEAD`);
    }

    const count = run('git', ['rev-list', '--count', `${tagName}..HEAD`]);
    const countText = count.status === 0 ? count.stdout.trim() : 'unknown';
    return pass(
      `${tagName} points at ${tagSha.slice(0, 12)}; HEAD has ${countText} ` +
        'post-release commit(s), so bump before the next tag',
      true
    );
  }
});

if (full) {
  addCommandCheck({
    name: 'platform package install smoke',
    command: process.execPath,
    args: ['test/platform-package-install-smoke.js'],
    success: 'platform package install ok'
  });
  addCommandCheck({
    name: 'package install smoke',
    command: process.execPath,
    args: ['test/package-install-smoke.js'],
    success: 'package install ok'
  });
  checks.push({
    name: 'registry install smoke',
    run: () => {
      if (publicationState?.state !== 'published') {
        return pass('skipped because current version is not published');
      }
      const result = run(process.execPath, [
        'scripts/check-registry-install.js',
        '--version',
        rootPackage.version
      ]);
      if (result.status === 0) {
        return pass(trimForDetail(result.stdout) || 'registry install ok');
      }
      return fail(
        trimForDetail(result.stderr) ||
          trimForDetail(result.stdout) ||
          `registry install exited ${result.status}`
      );
    }
  });
}

const results = checks.map((check) => {
  const result = {
    name: check.name,
    ...check.run()
  };
  return result;
});
const failures = results.filter((result) => !result.ok);
const warnings = results.filter((result) => result.warning);
const status = failures.length > 0
  ? 'failed'
  : publicationState?.state === 'published' &&
      warnings.some((result) => /post-release/.test(result.detail))
    ? 'healthy-post-release'
    : publicationState?.state === 'available'
      ? 'healthy-unreleased'
      : 'healthy';

if (json) {
  console.log(
    JSON.stringify(
      {
        package: rootPackage.name,
        version: rootPackage.version,
        expectedTag,
        full,
        allowDirty,
        status,
        results
      },
      null,
      2
    )
  );
} else {
  for (const result of results) {
    const marker = result.ok ? (result.warning ? 'warn' : 'ok') : 'fail';
    const suffix = result.detail ? `: ${oneLine(result.detail)}` : '';
    console.log(`${marker} ${result.name}${suffix}`);
  }
  console.log(`status ${status}`);
}

process.exitCode = failures.length > 0 ? 1 : 0;

function addCommandCheck({
  name,
  command,
  args: commandArgs,
  pass: passFn,
  failure,
  success
}) {
  checks.push({
    name,
    run: () => {
      const result = run(command, commandArgs);
      const ok = passFn ? passFn(result) : result.status === 0;
      if (ok) {
        return pass(success || trimForDetail(result.stdout));
      }
      return fail(
        failure
          ? failure(result)
          : trimForDetail(result.stderr) ||
              trimForDetail(result.stdout) ||
              `${command} exited ${result.status}`
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
      npm_config_dry_run:
        command === 'npm' && commandArgs.includes('--dry-run')
          ? 'true'
          : process.env.npm_config_dry_run
    },
    maxBuffer: 20 * 1024 * 1024
  });
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    return null;
  }
}

function pass(detail = '', warning = false) {
  return { ok: true, warning, detail };
}

function fail(detail) {
  return { ok: false, warning: false, detail };
}

function trimForDetail(value) {
  return (value || '').trim().split('\n').slice(-1)[0] || '';
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
