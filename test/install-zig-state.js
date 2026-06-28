'use strict';

const assert = require('node:assert/strict');

const {
  candidateUrls,
  releaseFor,
  releases,
  sourceName
} = require('../scripts/install-zig');

const x64 = releaseFor('0.13.0', 'linux-x64');
assert.equal(x64.filename, 'zig-linux-x86_64-0.13.0.tar.xz');
assert.equal(x64.topLevelDirectory, 'zig-linux-x86_64-0.13.0');
assert.equal(
  x64.sha256,
  'd45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea'
);
assert.equal(x64.size, 47082308);

const arm64 = releaseFor('0.13.0', 'linux-arm64');
assert.equal(arm64.filename, 'zig-linux-aarch64-0.13.0.tar.xz');
assert.equal(
  arm64.sha256,
  '041ac42323837eb5624068acd8b00cd5777dac4cf91179e8dad7a7e90dd0c556'
);

assert.throws(() => releaseFor('0.12.0', 'linux-x64'), /unsupported Zig version/);
assert.throws(() => releaseFor('0.13.0', 'darwin-x64'), /unsupported Zig target/);

const urls = candidateUrls(x64, {
  mirrors: ['https://mirror.example/zig/', 'https://second.example'],
  shuffle: false
});
assert.deepEqual(urls, [
  `https://mirror.example/zig/${x64.filename}?source=${sourceName}`,
  `https://second.example/${x64.filename}?source=${sourceName}`,
  x64.officialUrl
]);

assert.equal(Object.keys(releases['0.13.0']).sort().join(','), 'linux-arm64,linux-x64');

console.log('install-zig state ok');
