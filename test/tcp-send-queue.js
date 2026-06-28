'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('fill-send-queue'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error(`timed out after ${body.length} response bytes`));
    });
  });
}

(async () => {
  assert.throws(
    () => new UringTcpServer({ sendQueueCapacity: 0 }),
    /sendQueueCapacity must be at least 1/
  );

  let sent = false;
  const chunkCount = 32;
  const chunkSize = 512;
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    sendQueueCapacity: 1
  });
  const info = server.start((event) => {
    if (event.eventType !== 'data' || sent) {
      return;
    }
    sent = true;
    const sends = [];
    for (let index = 0; index < chunkCount; index += 1) {
      sends.push({
        connectionId: event.connectionId,
        data: Buffer.alloc(chunkSize, 65 + (index % 26))
      });
    }
    assert.equal(server.sendBatchAndClose(sends), true);
  });
  assert.equal(info.sendQueueCapacity, 1);
  assert.equal(info.sendQueueDrops, 0);

  try {
    const response = await roundTrip(info.port);
    assert.ok(response.length > 0, 'expected at least one queued response chunk');
    assert.ok(
      response.length < chunkCount * chunkSize,
      'expected overflowed send chunks to be dropped'
    );

    const stats = await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.sendQueueDrops > 0 ? candidate : null;
      },
      'server.info() did not report send queue drops'
    );
    assert.equal(stats.sendQueueCapacity, 1);
    assert.ok(stats.sendQueueDrops > 0);
  } finally {
    server.stop();
  }

  console.log('tcp send queue backpressure ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
