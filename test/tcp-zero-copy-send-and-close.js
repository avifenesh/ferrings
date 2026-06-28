'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

const HEAP_FALLBACK = '-heap-fallback'.repeat(8);

function roundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from(payload));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(1500, () => {
      socket.destroy(new Error(`timed out waiting for zero-copy FIN after ${body.length} bytes`));
    });
  });
}

async function waitForInfo(server, predicate) {
  const deadline = Date.now() + 1500;
  let lastInfo = null;
  while (Date.now() < deadline) {
    lastInfo = server.info();
    if (lastInfo && predicate(lastInfo)) {
      return lastInfo;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(lastInfo, 'server.info() should be available while running');
  assert.ok(predicate(lastInfo), `server.info() did not reach expected zero-copy send stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

async function withZeroCopyServer(start) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    useZeroCopySend: true,
    sendBufferCount: 1,
    sendBufferSize: 64
  });
  const info = start(server);
  assert.equal(info.zeroCopySend, true);
  assert.equal(info.registeredSendBuffer, true);
  assert.equal(info.zeroCopySendRequests, 0);
  assert.equal(info.zeroCopySendNotifications, 0);
  assert.equal(info.zeroCopySendCopied, 0);
  assert.equal(info.zeroCopySendErrors, 0);
  try {
    const response = await roundTrip(info.port, 'ping');
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.zeroCopySendRequests > 0 && candidate.zeroCopySendNotifications > 0
    );
    assert.ok(stats.zeroCopySendNotifications >= stats.zeroCopySendCopied);
    assert.equal(stats.zeroCopySendErrors, 0);
    return response;
  } finally {
    server.stop();
  }
}

(async () => {
  const single = await withZeroCopyServer((server) =>
    server.start((event) => {
      if (event.eventType === 'data') {
        assert.equal(server.sendAndClose(event.connectionId, Buffer.from('zc-close')), true);
      }
    })
  );
  assert.equal(single, 'zc-close');

  const batched = await withZeroCopyServer((server) =>
    server.startBatch((events) => {
      const sends = [];
      for (const event of events) {
        if (event.eventType === 'data') {
          sends.push({ connectionId: event.connectionId, data: Buffer.from('fixed') });
          sends.push({ connectionId: event.connectionId, data: Buffer.from(HEAP_FALLBACK) });
          sends.push({ connectionId: event.connectionId, data: Buffer.from('-done') });
        }
      }
      if (sends.length > 0) {
        assert.equal(server.sendBatchAndClose(sends), true);
      }
    })
  );
  assert.equal(batched, `fixed${HEAP_FALLBACK}-done`);

  console.log('tcp zero-copy send and close ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
