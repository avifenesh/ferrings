'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { scanContent } = require('../scripts/check-secrets');

const repoRoot = path.resolve(__dirname, '..');

const npmToken = ['npm_', 'A'.repeat(36)].join('');
const githubToken = ['ghp_', 'B'.repeat(36)].join('');
const awsAccessKey = ['AKIA', 'C'.repeat(16)].join('');
const privateKeyHeader = ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join('');
const npmTokenAssignment = ['NPM_TOKEN=', 'D'.repeat(40)].join('');
const npmrcPrefix = ['//registry.npmjs.org/', ':_authToken='].join('');
const npmrcToken = [npmrcPrefix, 'E'.repeat(40)].join('');

const findings = scanContent(
  [
    `token=${npmToken}`,
    `github=${githubToken}`,
    `aws=${awsAccessKey}`,
    privateKeyHeader,
    npmTokenAssignment,
    npmrcToken
  ].join('\n'),
  'fixture.txt'
);

assert.deepEqual(
  findings.map((finding) => finding.name),
  [
    'npm access token',
    'GitHub token',
    'AWS access key id',
    'private key block',
    'npm token assignment',
    'npmrc auth token'
  ]
);
assert.equal(findings[0].line, 1);
assert.equal(findings[1].line, 2);
assert.equal(findings[0].preview.includes('A'.repeat(20)), false, 'secret preview must be masked');

assert.deepEqual(
  scanContent(
    [
      'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
      'NPM_TOKEN is configured in GitHub secrets',
      `${npmrcPrefix}${'${NPM_TOKEN}'}`,
      'npm install ferrings'
    ].join('\n'),
    'safe-doc.txt'
  ),
  []
);

const clean = spawnSync(process.execPath, ['scripts/check-secrets.js'], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.equal(clean.status, 0, `expected clean tracked-file scan\nstdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`);
assert.match(clean.stdout, /secret scan ok/);

const cleanJson = spawnSync(process.execPath, ['scripts/check-secrets.js', '--json'], {
  cwd: repoRoot,
  encoding: 'utf8'
});
assert.equal(cleanJson.status, 0, `expected clean tracked-file JSON scan\nstderr:\n${cleanJson.stderr}`);
assert.equal(JSON.parse(cleanJson.stdout).ok, true);

console.log('secret scan state ok');
