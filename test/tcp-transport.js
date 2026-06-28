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
  let sawConnect = false;
  let sawData = false;
  let sawClose = false;

  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });

  const info = server.start((event) => {
    if (event.eventType === 'connect') {
      sawConnect = true;
      assert.equal(typeof event.connectionId, 'number');
      assert.equal(event.remoteAddress, '127.0.0.1');
      assert.equal(event.remoteFamily, 'IPv4');
      assert.equal(typeof event.remotePort, 'number');
      assert.ok(event.remotePort > 0);
      assert.match(event.remoteAddr, /^127\.0\.0\.1:\d+$/);
    } else if (event.eventType === 'data') {
      sawData = true;
      assert.equal(Buffer.isBuffer(event.data), true);
      assert.equal(event.data.toString('utf8'), 'ping');
      assert.equal(server.send(event.connectionId, Buffer.from('pong')), true);
    } else if (event.eventType === 'close') {
      sawClose = true;
    }
  });

  assert.equal(info.backend, 'io_uring');
  assert.equal(info.multishotAccept, true);
  assert.equal(info.multishotRecv, true);

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'pong');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sawConnect, true);
    assert.equal(sawData, true);
    assert.equal(sawClose, true);
  } finally {
    server.stop();
  }

  console.log('tcp transport ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
