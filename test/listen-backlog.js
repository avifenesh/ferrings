'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { UringHttpServer, UringTcpEchoServer, UringTcpServer } = require('../');

const BACKLOG = 7;

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function exerciseBacklog(name, server, start) {
  const info = start(server);
  assert.equal(info.backlog, BACKLOG);
  assert.equal(info.backend, 'io_uring');

  let socket = null;
  try {
    socket = await connect(info.port);
  } finally {
    if (socket) socket.destroy();
    server.stop();
  }

  console.log(`${name} listen backlog ok`);
}

(async () => {
  assert.throws(
    () => new UringHttpServer({ backlog: 0 }),
    /backlog must be between 1 and/
  );
  assert.throws(
    () => new UringTcpEchoServer({ backlog: 0 }),
    /backlog must be between 1 and/
  );
  assert.throws(
    () => new UringTcpServer({ backlog: 0 }),
    /backlog must be between 1 and/
  );

  await exerciseBacklog(
    'HTTP',
    new UringHttpServer({ host: '127.0.0.1', port: 0, backlog: BACKLOG }),
    (server) => server.start()
  );
  await exerciseBacklog(
    'native echo',
    new UringTcpEchoServer({ host: '127.0.0.1', port: 0, backlog: BACKLOG }),
    (server) => server.start()
  );
  await exerciseBacklog(
    'programmable TCP',
    new UringTcpServer({ host: '127.0.0.1', port: 0, backlog: BACKLOG }),
    (server) => server.start(() => {})
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
