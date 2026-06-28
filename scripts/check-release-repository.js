'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const packageArg = valueAfter('--package-json');
const packagePath = packageArg
  ? path.resolve(process.cwd(), packageArg)
  : path.resolve(__dirname, '..', 'package.json');
const rootPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const requireGithubMatch = process.argv.includes('--require-github-match');
const repositoryUrl = normalizeRepositoryUrl(rootPackage.repository);
const githubRepository = process.env.GITHUB_REPOSITORY || '';

if (!repositoryUrl) {
  fail('package.json repository.url is required for npm provenance publishing');
}

const repositorySlug = githubRepositorySlug(repositoryUrl);
if (!repositorySlug) {
  fail(`package.json repository.url must point at github.com, got: ${repositoryUrl}`);
}

if (requireGithubMatch) {
  if (!githubRepository) {
    fail('GITHUB_REPOSITORY is required when --require-github-match is set');
  }
  if (repositorySlug.toLowerCase() !== githubRepository.toLowerCase()) {
    fail(
      `package.json repository.url (${repositorySlug}) must match GITHUB_REPOSITORY (${githubRepository})`
    );
  }
}

console.log(
  githubRepository
    ? `release repository metadata ok (${repositorySlug}, workflow repo ${githubRepository})`
    : `release repository metadata ok (${repositorySlug})`
);

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string') {
    return repository;
  }
  if (repository && typeof repository.url === 'string') {
    return repository.url;
  }
  return '';
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}

function githubRepositorySlug(repository) {
  const trimmed = repository
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    return '';
  }
  const [owner, repo] = parsed.pathname.replace(/^\/+/, '').split('/');
  if (!owner || !repo) {
    return '';
  }
  return `${owner}/${repo}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
