'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('ping'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
      socket.end();
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  });
}

(async () => {
  assert.throws(
    () => new UringTcpServer({ eventBatchSize: 0 }),
    /eventBatchSize must be between/
  );
  assert.throws(
    () => new UringTcpServer({ eventQueueCapacity: 4, eventBatchSize: 5 }),
    /eventBatchSize must be between 1 and eventQueueCapacity/
  );

  let batches = 0;
  let sawData = false;

  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    eventBatchSize: 1
  });

  const info = server.startBatch((events) => {
    batches += 1;
    assert.equal(Array.isArray(events), true);
    assert.equal(events.length, 1);
    for (const event of events) {
      if (event.eventType === 'data') {
        sawData = true;
        assert.equal(Buffer.isBuffer(event.data), true);
        assert.equal(event.data.toString('utf8'), 'ping');
        assert.equal(server.send(event.connectionId, Buffer.from('batch-pong')), true);
      }
    }
  });

  assert.equal(info.backend, 'io_uring');
  assert.equal(info.multishotAccept, true);
  assert.equal(info.multishotRecv, true);
  assert.equal(info.eventBatchSize, 1);

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'batch-pong');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sawData, true);
    assert.ok(batches >= 1);
  } finally {
    server.stop();
  }

  console.log('tcp batch transport ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
