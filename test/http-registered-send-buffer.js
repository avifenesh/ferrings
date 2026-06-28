'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { UringHttpServer, capabilities } = require('../');

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
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
  const options = {
    host: '127.0.0.1',
    port: 0,
    responseBody: 'http registered send\n',
    bufferCount: 256,
    bufferSize: 2048,
    useRegisteredSendBuffer: true
  };

  if (!caps.registeredSendBuffer) {
    const server = new UringHttpServer(options);
    assert.throws(
      () => server.start(),
      /useRegisteredSendBuffer requested but active registered-buffer SEND probe failed/i
    );
    console.log('http registered send buffer guarded unsupported kernel ok');
    return;
  }

  const server = new UringHttpServer(options);
  const info = server.start();
  assert.equal(info.registeredSendBuffer, true);
  assert.equal(info.zeroCopySend, false);
  assert.equal(info.registeredSendRequests, 0);
  assert.equal(info.registeredSendErrors, 0);

  try {
    const response = await request(info.port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'http registered send\n');
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.registeredSendRequests > 0
    );
    assert.equal(stats.registeredSendErrors, 0);
    assert.equal(stats.zeroCopySendRequests, 0);
  } finally {
    server.stop();
  }

  console.log('http registered send buffer smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
