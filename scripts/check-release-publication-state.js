'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const version = valueAfter('--version') || rootPackage.version;
const expectedTag = valueAfter('--tag') || (version.includes('-') ? 'next' : 'latest');
const packages = [
  rootPackage.name,
  ...Object.keys(rootPackage.optionalDependencies || {})
];

const availability = packages.map((name) => checkPackageVersion(name, version));
const allAvailable = availability.every((entry) => entry.available);
const missingPackages = availability.filter((entry) => entry.available);
const existingPackages = availability.filter((entry) => !entry.available && /already exists/.test(entry.reason));
let state = 'available';
let published = null;
let errors = [];

if (!allAvailable) {
  const check = run(process.execPath, [
    'scripts/check-published.js',
    '--version',
    version,
    '--tag',
    expectedTag,
    '--json'
  ]);
  published = parseJson(check.stdout, 'check-published output');
  if (check.status === 0 && published?.ok) {
    state = 'published';
  } else if (existingPackages.length > 0 && missingPackages.length > 0) {
    state = 'partial';
    errors = [
      ...existingPackages.map((entry) => `${entry.name}@${version}: ${entry.reason}`),
      ...missingPackages.map((entry) => `${entry.name}@${version}: ${entry.reason}`),
      ...(published?.errors || [])
    ].filter(Boolean);
  } else {
    state = 'conflict';
    errors = [
      ...availability
        .filter((entry) => !entry.available)
        .map((entry) => `${entry.name}@${version}: ${entry.reason}`),
      ...(published?.errors || [npmFailure(check)])
    ].filter(Boolean);
  }
}

const report = {
  package: rootPackage.name,
  version,
  expectedTag,
  state,
  availability,
  published,
  errors
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (state === 'available') {
  console.log(`npm publication state: available (${rootPackage.name}@${version})`);
} else if (state === 'published') {
  console.log(`npm publication state: already published and verified (${rootPackage.name}@${version}, tag ${expectedTag})`);
} else if (state === 'partial') {
  console.log(`npm publication state: partially published (${rootPackage.name}@${version}, tag ${expectedTag})`);
} else {
  for (const error of errors) {
    console.error(error);
  }
}

process.exitCode = state === 'conflict' ? 1 : 0;

function checkPackageVersion(name, packageVersion) {
  const result = run('npm', ['view', `${name}@${packageVersion}`, 'version', '--json']);
  if (result.status === 0) {
    return {
      name,
      available: false,
      reason: `version ${packageVersion} already exists`
    };
  }
  if (isNpmNotFound(result)) {
    return {
      name,
      available: true,
      reason: `version ${packageVersion} is not published`
    };
  }
  return {
    name,
    available: false,
    reason: npmFailure(result)
  };
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    return {
      ok: false,
      errors: [`could not parse ${label}: ${error.message}`]
    };
  }
}

function isNpmNotFound(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status !== 0 && /\bE404\b|404 Not Found|not found/i.test(output);
}

function npmFailure(result) {
  return (
    result.error?.message ||
    (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0] ||
    `command exited ${result.status}`
  );
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}
