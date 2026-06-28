'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const packageArg = valueAfter('--package-json');
const repoRoot = path.resolve(__dirname, '..');
const packagePaths = packageArg
  ? [path.resolve(process.cwd(), packageArg)]
  : [
      path.join(repoRoot, 'package.json'),
      ...nativePackageJsonPaths()
    ];
const requireGithubMatch = process.argv.includes('--require-github-match');
const githubRepository = process.env.GITHUB_REPOSITORY || '';

const checked = [];
for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);

  if (!repositoryUrl) {
    fail(`${relative(packagePath)} repository.url is required for npm provenance publishing`);
  }

  const repositorySlug = githubRepositorySlug(repositoryUrl);
  if (!repositorySlug) {
    fail(`${relative(packagePath)} repository.url must point at github.com, got: ${repositoryUrl}`);
  }

  if (requireGithubMatch) {
    if (!githubRepository) {
      fail('GITHUB_REPOSITORY is required when --require-github-match is set');
    }
    if (repositorySlug.toLowerCase() !== githubRepository.toLowerCase()) {
      fail(
        `${relative(packagePath)} repository.url (${repositorySlug}) must match GITHUB_REPOSITORY (${githubRepository})`
      );
    }
  }

  checked.push(`${relative(packagePath)}=${repositorySlug}`);
}

console.log(
  githubRepository
    ? `release repository metadata ok (${checked.join(', ')}, workflow repo ${githubRepository})`
    : `release repository metadata ok (${checked.join(', ')})`
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

function nativePackageJsonPaths() {
  const npmRoot = path.join(repoRoot, 'npm');
  if (!fs.existsSync(npmRoot)) {
    return [];
  }
  return fs
    .readdirSync(npmRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(npmRoot, entry.name, 'package.json'))
    .filter((entryPath) => fs.existsSync(entryPath))
    .sort();
}

function relative(filePath) {
  return path.relative(repoRoot, filePath);
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
