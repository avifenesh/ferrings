'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringTcpServer, capabilities } = require('../');

const TOTAL = Number(process.env.FERRINGS_STARVATION_CONNECTIONS || 16);
const PAYLOAD_SIZE = Number(process.env.FERRINGS_STARVATION_PAYLOAD_SIZE || 8192);

function payloadFor(id) {
  const data = Buffer.alloc(PAYLOAD_SIZE, id % 251);
  data.write(`id:${String(id).padStart(4, '0')}:`, 0, 'ascii');
  return data;
}

function roundTrip(port, id) {
  const expected = payloadFor(id);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(expected);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      try {
        assert.deepEqual(body, expected);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy(new Error(`timed out waiting for starvation echo ${id} after ${body.length} bytes`));
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
  assert.ok(predicate(lastInfo), `server.info() did not reach expected starvation stats: ${JSON.stringify(lastInfo)}`);
  return lastInfo;
}

(async () => {
  if (!capabilities().recvBundle) {
    console.log('recv buffer starvation skipped: kernel does not report IORING_FEAT_RECVSEND_BUNDLE');
    return;
  }

  const chunksByConnection = new Map();
  const bytesByConnection = new Map();
  const closing = new Set();
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: 8,
    bufferCount: 2,
    bufferSize: 512,
    eventQueueCapacity: 4096,
    sendQueueCapacity: 512,
    useRecvBundle: true
  });

  const info = server.start((event) => {
    if (event.eventType !== 'data') return;

    const chunks = chunksByConnection.get(event.connectionId) || [];
    chunks.push(event.data);
    chunksByConnection.set(event.connectionId, chunks);

    const total = (bytesByConnection.get(event.connectionId) || 0) + event.data.length;
    bytesByConnection.set(event.connectionId, total);

    if (total >= PAYLOAD_SIZE && !closing.has(event.connectionId)) {
      closing.add(event.connectionId);
      assert.equal(server.sendAndClose(event.connectionId, Buffer.concat(chunks)), true);
    }
  });

  assert.equal(info.providedBufferRing, true);
  assert.equal(info.recvBundle, true);
  assert.equal(info.recvBufferStarvations, 0);
  assert.equal(info.recvMultishotResubmits, 0);

  try {
    await Promise.all(Array.from({ length: TOTAL }, (_, id) => roundTrip(info.port, id)));
    const stats = await waitForInfo(
      server,
      (candidate) =>
        candidate.closedConnections >= TOTAL &&
        candidate.recvBufferStarvations > 0 &&
        candidate.recvMultishotResubmits >= candidate.recvBufferStarvations
    );
    assert.equal(stats.eventQueueDrops, 0);
    assert.equal(stats.sendQueueDrops, 0);
    assert.ok(stats.recvBundleCompletions > 0);
    assert.ok(stats.recvBundleBytes >= TOTAL * PAYLOAD_SIZE);
    assert.ok(stats.bytesReceived >= TOTAL * PAYLOAD_SIZE);
    assert.ok(stats.bytesSent >= TOTAL * PAYLOAD_SIZE);
  } finally {
    server.stop();
  }

  console.log('recv buffer starvation recovery ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
