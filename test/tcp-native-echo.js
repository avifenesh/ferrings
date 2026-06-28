'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpEchoServer } = require('../');

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('native-ping'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error(`timed out waiting for native echo after ${body.length} bytes`));
    });
  });
}

(async () => {
  const server = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });

  const info = server.start();
  assert.equal(info.backend, 'io_uring');
  assert.equal(info.multishotAccept, true);
  assert.equal(info.multishotRecv, true);

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'native-ping');
  } finally {
    server.stop();
  }

  console.log('tcp native echo ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
