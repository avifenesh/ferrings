'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer, capabilities } = require('../');

function payload(size) {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  return data;
}

function roundTrip(port, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(data);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
    socket.setTimeout(1500, () => {
      socket.destroy(new Error(`timed out waiting for recv-bundle echo after ${body.length} bytes`));
    });
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
  assert.ok(predicate(lastInfo), `server.info() did not reach expected recv-bundle stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

(async () => {
  if (!capabilities().recvBundle) {
    console.log('recv bundle smoke skipped: kernel does not report IORING_FEAT_RECVSEND_BUNDLE');
    return;
  }

  const data = payload(4096);
  const seen = new Map();
  const closing = new Set();
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 512,
    useRecvBundle: true
  });

  const info = server.start((event) => {
    if (event.eventType !== 'data') return;
    const total = (seen.get(event.connectionId) || 0) + event.data.length;
    seen.set(event.connectionId, total);
    if (total >= data.length && !closing.has(event.connectionId)) {
      closing.add(event.connectionId);
      assert.equal(server.sendAndClose(event.connectionId, event.data), true);
    } else {
      assert.equal(server.send(event.connectionId, event.data), true);
    }
  });

  assert.equal(info.recvBundle, true);
  assert.equal(info.recvBundleCompletions, 0);
  assert.equal(info.recvBundleBuffers, 0);
  assert.equal(info.recvBundleBytes, 0);
  assert.equal(info.recvBufferStarvations, 0);
  assert.equal(info.recvMultishotResubmits, 0);

  try {
    const echoed = await roundTrip(info.port, data);
    assert.deepEqual(echoed, data);
    const stats = await waitForInfo(
      server,
      (candidate) => candidate.recvBundleCompletions > 0 && candidate.recvBundleBytes >= data.length
    );
    assert.ok(stats.recvBundleBuffers >= stats.recvBundleCompletions);
  } finally {
    server.stop();
  }

  console.log('recv bundle smoke ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
