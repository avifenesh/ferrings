'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { UringHttpServer } = require('../');

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        agent: false
      },
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

(async () => {
  const server = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    responseBody: 'ferrings smoke\n',
    bufferCount: 256,
    bufferSize: 2048
  });

  const info = server.start();
  assert.equal(info.multishotAccept, true);
  assert.equal(info.multishotRecv, true);
  assert.equal(info.zeroCopyReceive, false);
  assert.equal(info.zcrxReady, false);
  assert.equal(info.zcrxPackets, 0);
  assert.equal(info.zcrxBytes, 0);

  try {
    const response = await request(info.port);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'ferrings smoke\n');
  } finally {
    server.stop();
  }

  console.log('smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
