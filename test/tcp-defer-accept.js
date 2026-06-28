'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {
  createTcpServer,
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer
} = require('../');

const HOST = '127.0.0.1';
const DEFER_SECONDS = 1;
const HTTP_BODY = 'tcp-defer-accept-ok\n';

function httpGet(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: HOST, port, path: '/' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
  });
}

function tcpRoundTrip(port, payload = 'ping') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port });
    const chunks = [];
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function exerciseTcpDeferAccept(name, server, start, roundTrip) {
  const info = start(server);
  assert.equal(info.tcpDeferAcceptSeconds, DEFER_SECONDS);
  assert.equal(info.backend, 'io_uring');

  try {
    await roundTrip(info.port);
  } finally {
    server.stop();
  }

  console.log(`${name} tcp defer accept ok`);
}

(async () => {
  const defaultServer = new UringHttpServer({ host: HOST, port: 0 });
  try {
    const defaultInfo = defaultServer.start();
    assert.equal(defaultInfo.tcpDeferAcceptSeconds, 0);
  } finally {
    defaultServer.stop();
  }

  assert.throws(
    () => new UringTcpServer({ tcpDeferAcceptSeconds: 2147483648 }),
    /tcpDeferAcceptSeconds must be <=/
  );
  assert.throws(
    () => new UringHttpServer({ tcpDeferAcceptSeconds: 2147483648 }),
    /tcpDeferAcceptSeconds must be <=/
  );

  await exerciseTcpDeferAccept(
    'HTTP',
    new UringHttpServer({
      host: HOST,
      port: 0,
      tcpDeferAcceptSeconds: DEFER_SECONDS,
      responseBody: HTTP_BODY
    }),
    (server) => server.start(),
    async (port) => {
      assert.equal(await httpGet(port), HTTP_BODY);
    }
  );

  await exerciseTcpDeferAccept(
    'native echo',
    new UringTcpEchoServer({
      host: HOST,
      port: 0,
      tcpDeferAcceptSeconds: DEFER_SECONDS
    }),
    (server) => server.start(),
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );

  await exerciseTcpDeferAccept(
    'programmable TCP',
    new UringTcpServer({
      host: HOST,
      port: 0,
      tcpDeferAcceptSeconds: DEFER_SECONDS
    }),
    (server) =>
      server.start((event) => {
        if (event.eventType === 'data') {
          server.sendAndClose(event.connectionId, event.data);
        }
      }),
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );

  await exerciseTcpDeferAccept(
    'facade TCP',
    createTcpServer(
      {
        host: HOST,
        port: 0,
        tcpDeferAcceptSeconds: DEFER_SECONDS
      },
      (connection) => {
        connection.on('data', (data) => connection.end(data));
      }
    ),
    (server) => server.start(),
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
