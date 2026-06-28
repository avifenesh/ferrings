'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

function halfCloseRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.end(Buffer.from(payload));
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(1500, () => {
      socket.destroy(new Error(`timed out waiting for half-close response after ${body.length} bytes`));
    });
  });
}

async function withServer(options, start) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    ...options
  });
  const info = start(server);
  try {
    return await halfCloseRoundTrip(info.port, 'ping');
  } finally {
    server.stop();
  }
}

(async () => {
  const single = await withServer({}, (server) =>
    server.start((event) => {
      if (event.eventType === 'data') {
        assert.equal(event.data.toString('utf8'), 'ping');
        assert.equal(server.sendAndClose(event.connectionId, Buffer.from('pong')), true);
      }
    })
  );
  assert.equal(single, 'pong');

  const batch = await withServer({}, (server) =>
    server.startBatch((events) => {
      const sends = [];
      for (const event of events) {
        if (event.eventType === 'data') {
          assert.equal(event.data.toString('utf8'), 'ping');
          sends.push({ connectionId: event.connectionId, data: Buffer.from('batch-') });
          sends.push({ connectionId: event.connectionId, data: Buffer.from('pong') });
        }
      }
      if (sends.length > 0) {
        assert.equal(server.sendBatchAndClose(sends), true);
      }
    })
  );
  assert.equal(batch, 'batch-pong');

  const zeroCopy = await withServer(
    {
      useZeroCopySend: true,
      sendBufferCount: 1,
      sendBufferSize: 64
    },
    (server) =>
      server.start((event) => {
        if (event.eventType === 'data') {
          assert.equal(event.data.toString('utf8'), 'ping');
          assert.equal(server.sendAndClose(event.connectionId, Buffer.from('zc-pong')), true);
        }
      })
  );
  assert.equal(zeroCopy, 'zc-pong');

  console.log('tcp half-close ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
