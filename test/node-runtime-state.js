'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  nodeMajor,
  runtimeSupport,
  supportedNodeMajors
} = require('../scripts/node-runtime');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));

assert.deepEqual(
  supportedNodeMajors(rootPackage.engines.node),
  [22, 24, 26],
  'supported Node majors must match package engines'
);
assert.equal(nodeMajor('v26.4.0'), 26);
assert.equal(nodeMajor('24.15.0'), 24);

for (const version of ['22.21.1', '24.15.0', '26.4.0']) {
  assert.equal(runtimeSupport(rootPackage, version).ok, true, `${version} should be supported`);
}

for (const version of ['20.19.5', '23.11.1', '25.9.0']) {
  const support = runtimeSupport(rootPackage, version);
  assert.equal(support.ok, false, `${version} should not be supported`);
  assert.match(support.detail, /use Node\.js 22, 24, 26/);
}

console.log('node runtime state ok');
