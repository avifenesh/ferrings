'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const packageArg = valueAfter('--package-json');
const packagePath = packageArg
  ? path.resolve(process.cwd(), packageArg)
  : path.join(repoRoot, 'package.json');
const repoArg = valueAfter('--repo');
const dryRun = args.includes('--dry-run');
const repositorySlug = repoArg || githubRepositorySlugFromEnv() || githubRepositorySlugFromOrigin();

if (!repositorySlug) {
  fail(
    'could not determine GitHub repository; add an origin remote or pass --repo owner/name'
  );
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repositorySlug)) {
  fail(`expected --repo owner/name, got: ${repositorySlug}`);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const nextRepository = {
  type: 'git',
  url: `git+https://github.com/${repositorySlug}.git`
};
packageJson.repository = nextRepository;

if (dryRun) {
  console.log(JSON.stringify({ repository: nextRepository }, null, 2));
} else {
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

console.log(
  `${dryRun ? 'would set' : 'set'} package repository to ${nextRepository.url}`
);

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
