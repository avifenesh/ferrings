'use strict';

const assert = require('node:assert/strict');

assertExports(require('../'), 'root');
assertExports(require('../native'), 'native');

console.log('native send validation ok');

function assertExports(exports, label) {
  const server = new exports.UringTcpServer({ host: '127.0.0.1', port: 0 });
  server.start(() => {});

  try {
    assert.equal(server.send(0, Buffer.from('x')), true);
    assert.equal(server.sendAndClose(0, Buffer.from('x')), true);
    assert.equal(server.closeConnection(0), true);
    assert.equal(server.sendBatch([{ connectionId: 0, data: Buffer.from('x') }]), true);
    assert.equal(server.sendBatchAndClose([{ connectionId: 0, data: Buffer.from('x') }]), true);

    for (const connectionId of [-1, 1.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertInvalidConnectionId(label, server, connectionId);
    }
  } finally {
    server.stop();
  }
}

function assertInvalidConnectionId(label, server, connectionId) {
  const message = `${label} should reject connectionId ${String(connectionId)}`;
  const pattern = /connectionId must be an integer between 0 and 4294967295/;

  assert.throws(() => server.send(connectionId, Buffer.from('x')), pattern, message);
  assert.throws(() => server.sendAndClose(connectionId, Buffer.from('x')), pattern, message);
  assert.throws(() => server.closeConnection(connectionId), pattern, message);
  assert.throws(
    () => server.sendBatch([{ connectionId, data: Buffer.from('x') }]),
    pattern,
    message
  );
  assert.throws(
    () => server.sendBatchAndClose([{ connectionId, data: Buffer.from('x') }]),
    pattern,
    message
  );
}
