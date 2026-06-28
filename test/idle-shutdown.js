'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer
} = require('../');

const MAX_IDLE_STOP_MS = Number(process.env.FERRINGS_IDLE_STOP_MAX_MS || 80);

function assertIdleStop(name, makeServer, startServer) {
  const server = makeServer();
  const info = startServer(server);
  assert.equal(typeof info.port, 'number');
  assert.ok(info.port > 0);

  const start = performance.now();
  server.stop();
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < MAX_IDLE_STOP_MS,
    `${name} idle stop took ${elapsed.toFixed(1)}ms, expected < ${MAX_IDLE_STOP_MS}ms`
  );
}

assertIdleStop(
  'http',
  () => new UringHttpServer({ host: '127.0.0.1', port: 0 }),
  (server) => server.start()
);
assertIdleStop(
  'native tcp echo',
  () => new UringTcpEchoServer({ host: '127.0.0.1', port: 0 }),
  (server) => server.start()
);
assertIdleStop(
  'programmable tcp',
  () => new UringTcpServer({ host: '127.0.0.1', port: 0 }),
  (server) => server.start(() => {})
);

console.log('idle shutdown ok');
