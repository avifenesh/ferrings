'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer } = require('../');

function busyWait(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Hold the JS callback queue long enough for the native worker to apply pressure.
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(last, label);
}

(async () => {
  assert.throws(
    () => new UringTcpServer({ eventQueueCapacity: 0 }),
    /eventQueueCapacity must be between/
  );
  assert.throws(
    () => new UringTcpServer({ eventQueueCapacity: 65537 }),
    /eventQueueCapacity must be between/
  );

  let callbacks = 0;
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    eventQueueCapacity: 1
  });
  const info = server.start(() => {
    callbacks += 1;
    if (callbacks === 1) {
      busyWait(150);
    }
  });
  assert.equal(info.eventQueueCapacity, 1);
  assert.equal(info.eventBatchSize, 1);
  assert.equal(info.eventQueueDrops, 0);

  const sockets = [];
  try {
    for (let index = 0; index < 256; index += 1) {
      const socket = net.createConnection({ host: '127.0.0.1', port: info.port });
      socket.on('error', () => {});
      sockets.push(socket);
    }

    const stats = await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.eventQueueDrops > 0 ? candidate : null;
      },
      'server.info() did not report event queue drops'
    );
    assert.ok(stats.eventQueueDrops > 0);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.stop();
  }

  console.log('tcp event queue backpressure ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
