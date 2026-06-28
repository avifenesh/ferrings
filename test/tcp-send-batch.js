'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const expected = Buffer.from('hello world');
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('ping'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length >= expected.length) {
        socket.end();
      }
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  });
}

(async () => {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });

  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(
        server.sendBatch([
          { connectionId: event.connectionId, data: Buffer.from('hello ') },
          { connectionId: event.connectionId, data: Buffer.from('world') }
        ]),
        true
      );
    }
  });

  try {
    const response = await roundTrip(info.port);
    assert.equal(response, 'hello world');
  } finally {
    server.stop();
  }

  console.log('tcp send batch ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
