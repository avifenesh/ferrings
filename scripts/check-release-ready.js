'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const json = args.includes('--json');
const full = args.includes('--full');
const requireZcrx = args.includes('--require-zcrx');
const checks = [];

addCommandCheck({
  name: 'tracked worktree clean',
  scope: 'local',
  command: 'git',
  args: ['status', '--porcelain', '--untracked-files=normal'],
  pass: ({ stdout }) => stdout.trim().length === 0,
  failure: ({ stdout }) => stdout.trim() || 'worktree has uncommitted changes',
  next: 'git status --short && git add <files> && git commit'
});

checks.push({
  name: `tag v${rootPackage.version} points at HEAD`,
  scope: 'local',
  next: `git tag -f -a v${rootPackage.version} -m "${rootPackage.name} v${rootPackage.version}" HEAD`,
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
  name: 'package metadata consistency',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-package-metadata.js'],
  success: 'metadata versions and links ok',
  next: 'npm run check:metadata'
});

addCommandCheck({
  name: 'GitHub Actions workflow lint',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-workflows.js'],
  success: 'workflow syntax and expressions ok',
  next: 'npm run check:workflows'
});

addCommandCheck({
  name: 'native package metadata',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-native-packages.js'],
  success: 'metadata ok',
  next: 'npm run check:native-packages'
});

addCommandCheck({
  name: 'npm package versions available',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/check-npm-names.js'],
  success: 'all package versions available',
  next: 'pick a new version or package name, then rerun npm run check:npm-names'
});

addCommandCheck({
  name: 'napi prepublish dry-run',
  scope: 'local',
  command: process.execPath,
  args: ['scripts/prepublish.js', '--dry-run'],
  success: 'prepublish dry-run ok'
});

addCommandCheck({
  name: 'npm publish dry-run',
  scope: 'local',
  command: 'npm',
  args: ['publish', '--dry-run', '--json'],
  success: 'publish tarball dry-run ok'
});

if (full) {
  addCommandCheck({
    name: 'platform package install smoke',
    scope: 'local',
    command: process.execPath,
    args: ['test/platform-package-install-smoke.js'],
    success: 'platform package install ok'
  });
  addCommandCheck({
    name: 'package install smoke',
    scope: 'local',
    command: process.execPath,
    args: ['test/package-install-smoke.js'],
    success: 'package install ok'
  });
}

checks.push({
  name: 'origin remote configured',
  scope: 'external',
  next: 'gh repo create <owner>/<repo> --public --source . --remote origin --push',
  run: () => {
    const result = run('git', ['config', '--get', 'remote.origin.url']);
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return fail('missing git remote origin');
    }
    return pass(result.stdout.trim());
  }
});

addCommandCheck({
  name: 'GitHub repository exists and is public',
  scope: 'external',
  command: process.execPath,
  args: ['scripts/check-github-repository.js'],
  success: 'GitHub repository public',
  next: 'gh repo create <owner>/<repo> --public --source . --remote origin --push'
});

checks.push({
  name: 'GitHub NPM_TOKEN secret configured',
  scope: 'external',
  next: 'gh secret set NPM_TOKEN --repo <owner>/<repo>',
  run: () => {
    const repository = githubRepositorySlugFromOrigin();
    if (!repository) {
      return fail('could not determine GitHub repository from origin');
    }
    const result = run('gh', ['secret', 'list', '--repo', repository, '--json', 'name']);
    if (result.status !== 0) {
      return fail(trimForDetail(result.stderr) || trimForDetail(result.stdout) || `gh secret list exited ${result.status}`);
    }
    let secrets;
    try {
      secrets = JSON.parse(result.stdout);
    } catch (error) {
      return fail(`could not parse gh secret list output: ${error.message}`);
    }
    if (!secrets.some((secret) => secret.name === 'NPM_TOKEN')) {
      return fail('NPM_TOKEN secret is missing');
    }
    return pass(`${repository} has NPM_TOKEN`);
  }
});

addCommandCheck({
  name: 'release repository metadata',
  scope: 'external',
  command: process.execPath,
  args: ['scripts/check-release-repository.js'],
  next: 'npm run configure:release-repository -- --repo <owner>/<repo> && npm run check:release-repository'
});

checks.push({
  name: 'ZCRX hardware proof configured',
  scope: 'external',
  optional: !requireZcrx,
  hardFail: requireZcrx,
  next: 'ZCRX_INTERFACE=<ifname> ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx',
  run: () => {
    if (!process.env.ZCRX_INTERFACE) {
      return fail('ZCRX_INTERFACE is not set; hardware receive proof has not run');
    }
    return pass(`ZCRX_INTERFACE=${process.env.ZCRX_INTERFACE}`);
  }
});

const results = checks.map((check) => {
  const result = {
    name: check.name,
    scope: check.scope,
    optional: check.optional === true,
    hardFail: check.hardFail === true,
    ...check.run()
  };
  if (!result.ok && check.next) {
    result.next = check.next;
  }
  return result;
});
const localFailures = results.filter((result) => result.scope === 'local' && !result.ok);
const externalFailures = results.filter((result) => result.scope === 'external' && !result.ok && !result.optional);
const optionalFailures = results.filter((result) => !result.ok && result.optional);
const hardFailures = results.filter((result) => !result.ok && result.hardFail);
const failed = localFailures.length > 0 || hardFailures.length > 0 || (strict && externalFailures.length > 0);
const status = failed
  ? 'failed'
  : externalFailures.length > 0
    ? 'external-blocked'
    : optionalFailures.length > 0
      ? 'ready-with-optional-blockers'
      : 'ready';

if (json) {
  console.log(
    JSON.stringify(
      {
        package: rootPackage.name,
        version: rootPackage.version,
        strict,
        full,
        requireZcrx,
        status,
        results
      },
      null,
      2
    )
  );
} else {
  for (const result of results) {
    const marker = result.ok
      ? 'ok'
      : result.optional
        ? 'optional'
        : result.scope === 'external' && !strict
          ? 'blocked'
          : 'fail';
    const suffix = result.detail ? `: ${oneLine(result.detail)}` : '';
    console.log(`${marker} ${result.scope} ${result.name}${suffix}`);
  }
  if (externalFailures.length > 0 && !strict) {
    console.log('external blockers remain; rerun with --strict when required remote and repository metadata exist');
  }
  if (optionalFailures.length > 0) {
    console.log('optional blockers remain; rerun with --require-zcrx when ZCRX hardware proof should gate this release');
  }
  const actionable = results.filter((result) => !result.ok && result.next);
  for (const result of actionable) {
    console.log(`next ${result.name}: ${result.next}`);
  }
}

process.exitCode = failed ? 1 : 0;

function addCommandCheck({ name, scope, command, args: commandArgs, pass: passFn, failure, success, next }) {
  checks.push({
    name,
    scope,
    next,
    run: () => {
      const result = run(command, commandArgs);
      const ok = passFn ? passFn(result) : result.status === 0;
      if (ok) {
        return pass(success || trimForDetail(result.stdout));
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

function githubRepositorySlugFromOrigin() {
  const result = run('git', ['config', '--get', 'remote.origin.url']);
  if (result.status !== 0) {
    return '';
  }
  return githubRepositorySlug(result.stdout.trim());
}

function githubRepositorySlug(repositoryUrl) {
  const normalized = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return '';
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    return '';
  }
  const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/');
  return owner && repo ? `${owner}/${repo}` : '';
}
