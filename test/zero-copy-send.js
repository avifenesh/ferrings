'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { UringHttpServer } = require('../');

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
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
  assert.ok(predicate(lastInfo), `server.info() did not reach expected zero-copy send stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

(async () => {
  const server = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    responseBody: 'ferrings zc\n',
    bufferCount: 256,
    bufferSize: 2048,
    useZeroCopySend: true
  });

  const info = server.start();
  assert.equal(info.zeroCopySend, true);
  assert.equal(info.zeroCopySendRequests, 0);
  assert.equal(info.zeroCopySendNotifications, 0);
  assert.equal(info.zeroCopySendCopied, 0);
  assert.equal(info.zeroCopySendErrors, 0);

  try {
    const response = await request(info.port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'ferrings zc\n');
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.zeroCopySendRequests > 0 && candidate.zeroCopySendNotifications > 0
    );
    assert.ok(stats.zeroCopySendNotifications >= stats.zeroCopySendCopied);
    assert.equal(stats.zeroCopySendErrors, 0);
  } finally {
    server.stop();
  }

  console.log('zero-copy send smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
