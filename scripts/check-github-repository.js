'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const repoArg = valueAfter('--repo');
const json = args.includes('--json');
const repositorySlug = repoArg || githubRepositorySlugFromEnv() || githubRepositorySlugFromOrigin();

if (!repositorySlug) {
  fail('could not determine GitHub repository; add origin or pass --repo owner/name');
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repositorySlug)) {
  fail(`expected GitHub owner/name, got: ${repositorySlug}`);
}

const result = spawnSync(
  'gh',
  ['repo', 'view', repositorySlug, '--json', 'nameWithOwner,url,visibility,defaultBranchRef'],
  {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  }
);

if (result.error) {
  fail(result.error.message);
}
if (result.status !== 0) {
  fail((result.stderr || result.stdout || '').trim() || `gh repo view exited ${result.status}`);
}

const report = JSON.parse(result.stdout);
if (report.visibility !== 'PUBLIC') {
  fail(`GitHub repository ${repositorySlug} must be public for npm provenance, got ${report.visibility}`);
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `github repository ok (${report.nameWithOwner}, ${report.visibility}, default ${report.defaultBranchRef?.name || 'unknown'})`
  );
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}

function githubRepositorySlugFromEnv() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  return /^[^/\s]+\/[^/\s]+$/.test(repository) ? repository : '';
}

function githubRepositorySlugFromOrigin() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
