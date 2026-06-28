'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

function roundTrip(port, expected) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.from('ping'));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error(`timed out waiting for server FIN after ${body.length} bytes`));
    });
  }).then((body) => {
    assert.equal(body, expected);
  });
}

async function withServer(start) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048
  });
  const info = start(server);
  try {
    return await roundTrip(info.port, 'hello world');
  } finally {
    server.stop();
  }
}

(async () => {
  await withServer((server) =>
    server.start((event) => {
      if (event.eventType === 'data') {
        assert.equal(server.sendAndClose(event.connectionId, Buffer.from('hello world')), true);
      }
    })
  );

  await withServer((server) =>
    server.startBatch((events) => {
      const sends = [];
      for (const event of events) {
        if (event.eventType === 'data') {
          sends.push({ connectionId: event.connectionId, data: Buffer.from('hello ') });
          sends.push({ connectionId: event.connectionId, data: Buffer.from('world') });
        }
      }
      if (sends.length > 0) {
        assert.equal(server.sendBatchAndClose(sends), true);
      }
    })
  );

  console.log('tcp send and close ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
