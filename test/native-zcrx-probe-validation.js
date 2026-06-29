'use strict';

const assert = require('node:assert/strict');

assertExports(require('../'), 'root');
assertExports(require('../native'), 'native');

console.log('native zcrx probe validation ok');

function assertExports(exports, label) {
  const valid = exports.zcrxProbe({
    interfaceName: 'lo',
    rxQueue: 0,
    rxBufferSize: 0,
    activeRegistration: false
  });
  assert.equal(valid.interfaceName, 'lo');
  assert.equal(valid.rxQueue, 0);
  assert.equal(valid.rxBufferSize, 0);
  assert.equal(valid.activeRegistration, false);

  const invalidNumbers = [-1, 1.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of invalidNumbers) {
    assert.throws(
      () => exports.zcrxProbe({ rxQueue: value }),
      /zcrxProbe rxQueue must be an integer between 0 and 4294967295/,
      `${label} should reject invalid rxQueue ${String(value)}`
    );
    assert.throws(
      () => exports.zcrxProbe({ rxBufferSize: value }),
      /zcrxProbe rxBufferSize must be an integer between 0 and 4294967295/,
      `${label} should reject invalid rxBufferSize ${String(value)}`
    );
  }

  assert.throws(
    () => exports.zcrxProbe({ interfaceName: '' }),
    /zcrxProbe interfaceName must be a non-empty string/,
    `${label} should reject an empty interfaceName`
  );
}
