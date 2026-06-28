'use strict';

const assert = require('node:assert/strict');
const { UringTcpServer } = require('../');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 500;
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
    () => new UringTcpServer({ commandQueueCapacity: 0 }),
    /commandQueueCapacity must be at least 1/
  );

  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    commandQueueCapacity: 1
  });
  const info = server.start(() => {});
  assert.equal(info.commandQueueCapacity, 1);
  assert.equal(info.commandQueueDrops, 0);

  try {
    let rejected = 0;
    for (let index = 0; index < 10000; index += 1) {
      if (!server.send(0xffffffff, Buffer.from('queued'))) {
        rejected += 1;
        break;
      }
    }
    assert.ok(rejected > 0, 'expected a full command queue to reject at least one send');

    const stats = await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.commandQueueDrops > 0 ? candidate : null;
      },
      'server.info() did not report command queue drops'
    );
    assert.ok(stats.commandQueueDrops >= rejected);
  } finally {
    server.stop();
  }

  console.log('tcp command queue backpressure ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
