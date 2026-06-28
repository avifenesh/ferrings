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
const HTTP_BODY = 'reuse-port-ok\n';

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

function stopAll(servers) {
  for (const server of servers.reverse()) {
    try {
      server.stop();
    } catch {
      // Best-effort cleanup for startup-failure assertions.
    }
  }
}

async function exerciseReusePortPair(name, createPair, exercise) {
  const servers = [];
  try {
    const first = createPair(0);
    servers.push(first.server);
    const firstInfo = first.start();
    assert.equal(firstInfo.reusePort, true);

    const second = createPair(firstInfo.port);
    servers.push(second.server);
    const secondInfo = second.start();
    assert.equal(secondInfo.reusePort, true);
    assert.equal(secondInfo.port, firstInfo.port);

    await exercise(firstInfo.port);
    console.log(`${name} reusePort ok`);
  } finally {
    stopAll(servers);
  }
}

(async () => {
  const defaultServer = new UringHttpServer({ host: HOST, port: 0 });
  try {
    const defaultInfo = defaultServer.start();
    assert.equal(defaultInfo.reusePort, false);
  } finally {
    defaultServer.stop();
  }

  const exclusive = new UringHttpServer({ host: HOST, port: 0 });
  try {
    const info = exclusive.start();
    assert.throws(
      () =>
        new UringHttpServer({
          host: HOST,
          port: info.port,
          reusePort: true
        }).start(),
      /address already in use|EADDRINUSE/i
    );
  } finally {
    exclusive.stop();
  }

  await exerciseReusePortPair(
    'HTTP',
    (port) => {
      const server = new UringHttpServer({
        host: HOST,
        port,
        reusePort: true,
        responseBody: HTTP_BODY
      });
      return { server, start: () => server.start() };
    },
    async (port) => {
      assert.equal(await httpGet(port), HTTP_BODY);
    }
  );

  await exerciseReusePortPair(
    'native echo',
    (port) => {
      const server = new UringTcpEchoServer({ host: HOST, port, reusePort: true });
      return { server, start: () => server.start() };
    },
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );

  await exerciseReusePortPair(
    'programmable TCP',
    (port) => {
      const server = new UringTcpServer({ host: HOST, port, reusePort: true });
      return {
        server,
        start: () =>
          server.start((event) => {
            if (event.eventType === 'data') {
              server.sendAndClose(event.connectionId, event.data);
            }
          })
      };
    },
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );

  await exerciseReusePortPair(
    'facade TCP',
    (port) => {
      const server = createTcpServer(
        { host: HOST, port, reusePort: true },
        (connection) => {
          connection.on('data', (data) => connection.end(data));
        }
      );
      return { server, start: () => server.start() };
    },
    async (port) => {
      assert.equal(await tcpRoundTrip(port), 'ping');
    }
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
