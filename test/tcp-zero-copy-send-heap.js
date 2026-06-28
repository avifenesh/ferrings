'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

const PAYLOAD = Buffer.alloc(4096, 'h');

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('ping'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
    socket.setTimeout(1500, () => {
      socket.destroy(new Error(`timed out after ${body.length} bytes`));
    });
  });
}

async function waitForInfo(server, predicate) {
  const deadline = Date.now() + 1500;
  let lastInfo = null;
  while (Date.now() < deadline) {
    lastInfo = server.info();
    if (lastInfo && predicate(lastInfo)) return lastInfo;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(lastInfo, 'server.info() should be available while running');
  assert.ok(predicate(lastInfo), `server.info() did not reach expected heap zero-copy send stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

(async () => {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    useZeroCopySend: true,
    sendBufferCount: 1,
    sendBufferSize: 64
  });

  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(server.sendAndClose(event.connectionId, PAYLOAD), true);
    }
  });

  assert.equal(info.zeroCopySend, true);
  assert.equal(info.registeredSendBuffer, true);
  assert.equal(info.registeredSendRequests, 0);
  assert.equal(info.fixedSendBufferMisses, 0);
  assert.equal(info.fixedSendBufferMissBytes, 0);
  assert.equal(info.zeroCopySendRequests, 0);

  try {
    const response = await roundTrip(info.port);
    assert.deepEqual(response, PAYLOAD);
    const stats = await waitForInfo(
      server,
      (candidate) =>
        candidate.zeroCopySendRequests > 0 &&
        candidate.zeroCopySendNotifications > 0 &&
        candidate.closedConnections >= 1
    );
    assert.equal(stats.registeredSendRequests, 0);
    assert.equal(stats.registeredSendErrors, 0);
    assert.ok(stats.fixedSendBufferMisses > 0);
    assert.ok(stats.fixedSendBufferMissBytes >= PAYLOAD.length);
    assert.equal(stats.zeroCopySendErrors, 0);
  } finally {
    server.stop();
  }

  console.log('tcp heap zero-copy send ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
