'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringHttpServer, UringTcpEchoServer, UringTcpServer } = require('../');

const IDLE_TIMEOUT_MS = 250;

async function waitForInfo(server, predicate, label) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    last = server.info();
    if (last && predicate(last)) return last;
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

function waitForClose(socket, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`${label} did not close`));
    }, 2000);

    socket.on('error', () => {});
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function exerciseIdleTimeout(name, server, start) {
  const info = start(server);
  assert.equal(info.idleTimeoutMs, IDLE_TIMEOUT_MS);
  assert.equal(info.idleTimeouts, 0);

  let socket = null;
  try {
    socket = await connect(info.port);
    await waitForInfo(
      server,
      (candidate) =>
        candidate.acceptedConnections === 1 && candidate.activeConnections === 1,
      `${name} did not track the idle connection`
    );

    await waitForClose(socket, `${name} idle connection`);
    socket = null;

    const stats = await waitForInfo(
      server,
      (candidate) =>
        candidate.idleTimeouts >= 1 && candidate.activeConnections === 0,
      `${name} did not evict the idle connection`
    );
    assert.equal(stats.idleTimeoutMs, IDLE_TIMEOUT_MS);
    assert.equal(stats.acceptedConnections, 1);
    assert.equal(stats.rejectedConnections, 0);
    assert.equal(stats.closedConnections, 1);
  } finally {
    if (socket) socket.destroy();
    server.stop();
  }
}

(async () => {
  await exerciseIdleTimeout(
    'HTTP',
    new UringHttpServer({
      host: '127.0.0.1',
      port: 0,
      idleTimeoutMs: IDLE_TIMEOUT_MS
    }),
    (server) => server.start()
  );
  await exerciseIdleTimeout(
    'native echo',
    new UringTcpEchoServer({
      host: '127.0.0.1',
      port: 0,
      idleTimeoutMs: IDLE_TIMEOUT_MS
    }),
    (server) => server.start()
  );
  await exerciseIdleTimeout(
    'programmable TCP',
    new UringTcpServer({
      host: '127.0.0.1',
      port: 0,
      idleTimeoutMs: IDLE_TIMEOUT_MS
    }),
    (server) => server.start(() => {})
  );

  console.log('connection idle timeout ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
