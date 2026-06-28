'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const rootPackage = require(path.resolve(__dirname, '..', 'package.json'));
const requireNewNames = process.argv.includes('--require-new-names');
const json = process.argv.includes('--json');
const packages = [
  rootPackage.name,
  ...Object.keys(rootPackage.optionalDependencies || {})
];
const results = [];
let failed = false;

for (const name of packages) {
  const check = requireNewNames
    ? checkPackageName(name)
    : checkPackageVersion(name, rootPackage.version);
  results.push(check);
  if (!check.available) {
    failed = true;
  }
}

if (json) {
  console.log(JSON.stringify({ version: rootPackage.version, requireNewNames, results }, null, 2));
} else {
  for (const result of results) {
    const subject = requireNewNames
      ? result.name
      : `${result.name}@${rootPackage.version}`;
    console.log(`${subject}: ${result.available ? 'available' : 'unavailable'} (${result.reason})`);
  }
}

if (failed) {
  process.exitCode = 1;
}

function checkPackageName(name) {
  const result = npmView([name, 'name', '--json']);
  if (result.status === 0) {
    return {
      name,
      available: false,
      reason: 'package name already exists'
    };
  }
  if (isNpmNotFound(result)) {
    return {
      name,
      available: true,
      reason: 'package name is unpublished'
    };
  }
  return unexpectedFailure(name, result);
}

function checkPackageVersion(name, version) {
  const result = npmView([`${name}@${version}`, 'version', '--json']);
  if (result.status === 0) {
    return {
      name,
      available: false,
      reason: `version ${version} already exists`
    };
  }
  if (isNpmNotFound(result)) {
    return {
      name,
      available: true,
      reason: `version ${version} is not published`
    };
  }
  return unexpectedFailure(name, result);
}

function npmView(args) {
  return spawnSync('npm', ['view', ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
}

function isNpmNotFound(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status !== 0 && /\bE404\b|404 Not Found|not found/i.test(output);
}

function unexpectedFailure(name, result) {
  return {
    name,
    available: false,
    reason:
      result.error?.message ||
      `npm view failed with status ${result.status}: ${(result.stderr || result.stdout || '').trim()}`
  };
}
