'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { UringTcpServer } = require('../');

function socketFdCount() {
  let count = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith('socket:')) {
        count += 1;
      }
    } catch {
      // The fd directory is live; entries can disappear while counting.
    }
  }
  return count;
}

async function stopWithPendingZeroCopySend() {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    useZeroCopySend: true,
    sendBufferCount: 1,
    sendBufferSize: 65536
  });
  const payload = Buffer.alloc(65536, 'z');
  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(server.send(event.connectionId, payload), true);
    }
  });

  const client = net.createConnection({ host: '127.0.0.1', port: info.port }, () => {
    client.write('go');
  });
  client.pause();
  await new Promise((resolve) => setTimeout(resolve, 20));

  server.stop();
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

(async () => {
  const before = socketFdCount();
  for (let i = 0; i < 5; i += 1) {
    await stopWithPendingZeroCopySend();
  }
  assert.equal(socketFdCount(), before);
  console.log('tcp zero-copy shutdown ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
