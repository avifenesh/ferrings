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

(async () => {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    useZeroCopySend: true,
    sendBufferCount: 64,
    sendBufferSize: 2048
  });

  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(server.send(event.connectionId, Buffer.from('pong-zc')), true);
    }
  });

  assert.equal(info.zeroCopySend, true);
  assert.equal(info.registeredSendBuffer, true);
  assert.equal(info.sendBufferCount, 64);
  assert.equal(info.sendBufferSize, 2048);
  assert.equal(info.zeroCopySendRequests, 0);
  assert.equal(info.zeroCopySendNotifications, 0);
  assert.equal(info.zeroCopySendCopied, 0);
  assert.equal(info.zeroCopySendErrors, 0);
  assert.equal(info.fixedSendBufferMisses, 0);
  assert.equal(info.fixedSendBufferMissBytes, 0);

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'pong-zc');
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.zeroCopySendRequests > 0 && candidate.zeroCopySendNotifications > 0
    );
    assert.ok(stats.zeroCopySendNotifications >= stats.zeroCopySendCopied);
    assert.equal(stats.zeroCopySendErrors, 0);
    assert.equal(stats.fixedSendBufferMisses, 0);
    assert.equal(stats.fixedSendBufferMissBytes, 0);
  } finally {
    server.stop();
  }

  console.log('tcp zero-copy send smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
