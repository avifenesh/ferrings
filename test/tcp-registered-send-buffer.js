'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer, capabilities } = require('../');

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
  assert.ok(predicate(lastInfo), `server.info() did not reach expected registered-send stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

(async () => {
  const caps = capabilities();
  assert.equal(typeof caps.registeredSendBuffer, 'boolean');
  assert.equal(typeof caps.registeredSendBufferProbe, 'string');
  assert.ok(caps.registeredSendBufferProbe.length > 0);
  if (!caps.registeredSendBuffer) {
    const server = new UringTcpServer({
      host: '127.0.0.1',
      port: 0,
      bufferCount: 256,
      bufferSize: 2048,
      useRegisteredSendBuffer: true,
      sendBufferCount: 64,
      sendBufferSize: 2048
    });
    assert.throws(
      () => server.start(() => {}),
      /useRegisteredSendBuffer requested but active registered-buffer SEND probe failed/i
    );
    console.log('tcp registered send buffer guarded unsupported kernel ok');
    return;
  }

  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    useRegisteredSendBuffer: true,
    sendBufferCount: 64,
    sendBufferSize: 2048
  });

  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(server.send(event.connectionId, Buffer.from('pong-registered')), true);
    }
  });

  assert.equal(info.registeredSendBuffer, true);
  assert.equal(info.zeroCopySend, false);
  assert.equal(info.sendBufferCount, 64);
  assert.equal(info.sendBufferSize, 2048);
  assert.equal(info.registeredSendRequests, 0);
  assert.equal(info.registeredSendErrors, 0);
  assert.equal(info.fixedSendBufferMisses, 0);
  assert.equal(info.fixedSendBufferMissBytes, 0);
  assert.equal(info.zeroCopySendRequests, 0);

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'pong-registered');
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.registeredSendRequests > 0
    );
    assert.equal(stats.registeredSendErrors, 0);
    assert.equal(stats.fixedSendBufferMisses, 0);
    assert.equal(stats.fixedSendBufferMissBytes, 0);
    assert.equal(stats.zeroCopySendRequests, 0);
  } finally {
    server.stop();
  }

  console.log('tcp registered send buffer smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
