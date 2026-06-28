'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { UringHttpServer, UringTcpEchoServer, UringTcpServer } = require('../');

async function waitForStats(server, predicate, label) {
  const deadline = Date.now() + 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = server.info();
    if (last && predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

function assertInitialStats(info) {
  assert.equal(info.acceptedConnections, 0);
  assert.equal(info.closedConnections, 0);
  assert.equal(info.activeConnections, 0);
  assert.equal(info.bytesReceived, 0);
  assert.equal(info.bytesSent, 0);
  assert.equal(info.recvCopyEvents, 0);
  assert.equal(info.recvCopyBytes, 0);
  assert.equal(info.fixedSendBufferMisses, 0);
  assert.equal(info.fixedSendBufferMissBytes, 0);
}

function assertRoundTripStats(info, minReceived, minSent, expectedRecvCopyBytes) {
  assert.ok(info.acceptedConnections >= 1, 'acceptedConnections should increase');
  assert.ok(info.closedConnections >= 1, 'closedConnections should increase');
  assert.equal(info.activeConnections, 0);
  assert.ok(info.bytesReceived >= minReceived, 'bytesReceived should include payload bytes');
  assert.ok(info.bytesSent >= minSent, 'bytesSent should include response bytes');
  if (expectedRecvCopyBytes === 0) {
    assert.equal(info.recvCopyEvents, 0, 'HTTP fixed-response path should not copy recv bytes');
    assert.equal(info.recvCopyBytes, 0, 'HTTP fixed-response path should parse recv buffers in place');
  } else {
    assert.ok(info.recvCopyEvents >= 1, 'recvCopyEvents should increase when receive data is owned past recycle');
    assert.ok(
      info.recvCopyBytes >= expectedRecvCopyBytes,
      'recvCopyBytes should include copied receive payload bytes'
    );
  }
}

function httpRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        agent: false
      },
      (res) => {
        let body = Buffer.alloc(0);
        res.on('data', (chunk) => {
          body = Buffer.concat([body, chunk]);
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
  });
}

function tcpRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error(`timed out after ${body.length} bytes`));
    });
  });
}

async function testHttpStats() {
  const responseBody = 'stats-http\n';
  const responseBytes = Buffer.byteLength(responseBody);
  const server = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    responseBody,
    bufferCount: 256,
    bufferSize: 2048
  });
  const info = server.start();
  assertInitialStats(info);

  try {
    const response = await httpRequest(info.port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString('utf8'), responseBody);

    const stats = await waitForStats(
      server,
      (candidate) =>
        candidate.acceptedConnections >= 1 &&
        candidate.closedConnections >= 1 &&
        candidate.activeConnections === 0 &&
        candidate.bytesReceived > 0 &&
        candidate.bytesSent >= responseBytes,
      'HTTP transport stats did not settle'
    );
    assertRoundTripStats(stats, 1, responseBytes, 0);
  } finally {
    server.stop();
  }
}

async function testNativeEchoStats() {
  const payload = Buffer.from('native-stats-ping');
  const server = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });
  const info = server.start();
  assertInitialStats(info);

  try {
    const response = await tcpRoundTrip(info.port, payload);
    assert.deepEqual(response, payload);

    const stats = await waitForStats(
      server,
      (candidate) =>
        candidate.acceptedConnections >= 1 &&
        candidate.closedConnections >= 1 &&
        candidate.activeConnections === 0 &&
        candidate.bytesReceived >= payload.length &&
        candidate.bytesSent >= payload.length,
      'native echo stats did not settle'
    );
    assertRoundTripStats(stats, payload.length, payload.length, payload.length);
  } finally {
    server.stop();
  }
}

async function testProgrammableTcpStats() {
  const payload = Buffer.from('programmable-stats-ping');
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });
  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(server.sendAndClose(event.connectionId, event.data), true);
    }
  });
  assertInitialStats(info);

  try {
    const response = await tcpRoundTrip(info.port, payload);
    assert.deepEqual(response, payload);

    const stats = await waitForStats(
      server,
      (candidate) =>
        candidate.acceptedConnections >= 1 &&
        candidate.closedConnections >= 1 &&
        candidate.activeConnections === 0 &&
        candidate.bytesReceived >= payload.length &&
        candidate.bytesSent >= payload.length,
      'programmable TCP stats did not settle'
    );
    assertRoundTripStats(stats, payload.length, payload.length, payload.length);
  } finally {
    server.stop();
  }
}

(async () => {
  await testHttpStats();
  await testNativeEchoStats();
  await testProgrammableTcpStats();
  console.log('transport stats ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
