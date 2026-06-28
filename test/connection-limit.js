'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringHttpServer, UringTcpEchoServer, UringTcpServer } = require('../');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function openRejectedCandidate(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  return socket;
}

async function exerciseLimit(name, server, start) {
  const info = start(server);
  assert.equal(info.maxConnections, 1);
  assert.equal(info.rejectedConnections, 0);

  let held = null;
  let rejected = null;
  try {
    held = await connect(info.port);
    await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.activeConnections === 1 ? candidate : null;
      },
      `${name} did not track the held connection`
    );

    rejected = openRejectedCandidate(info.port);
    const stats = await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.rejectedConnections >= 1 ? candidate : null;
      },
      `${name} did not reject the over-limit connection`
    );
    assert.equal(stats.acceptedConnections, 1);
    assert.equal(stats.activeConnections, 1);

    held.destroy();
    held = null;
    await waitFor(
      () => {
        const candidate = server.info();
        return candidate && candidate.activeConnections === 0 ? candidate : null;
      },
      `${name} did not close the held connection`
    );
  } finally {
    if (held) held.destroy();
    if (rejected) rejected.destroy();
    server.stop();
  }
}

(async () => {
  await exerciseLimit(
    'HTTP',
    new UringHttpServer({ host: '127.0.0.1', port: 0, maxConnections: 1 }),
    (server) => server.start()
  );
  await exerciseLimit(
    'native echo',
    new UringTcpEchoServer({ host: '127.0.0.1', port: 0, maxConnections: 1 }),
    (server) => server.start()
  );
  await exerciseLimit(
    'programmable TCP',
    new UringTcpServer({ host: '127.0.0.1', port: 0, maxConnections: 1 }),
    (server) => server.start(() => {})
  );

  console.log('connection limit ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
