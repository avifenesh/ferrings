'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { UringHttpServer, UringTcpEchoServer, UringTcpServer } = require('../');

const TOTAL = Number(process.env.FERRINGS_CONCURRENCY_REQUESTS || 256);
const CONCURRENCY = Number(process.env.FERRINGS_CONCURRENCY || 32);

async function runFixedLoad(total, concurrency, task) {
  let next = 0;

  async function worker() {
    while (next < total) {
      const id = next;
      next += 1;
      await task(id);
    }
  }

  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, worker));
}

function httpOnce(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        agent: false
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            assert.equal(body, 'concurrency-ok\n');
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('HTTP concurrency request timed out'));
    });
  });
}

function tcpOnce(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      try {
        assert.deepEqual(body, payload);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(2000, () => {
      socket.destroy(new Error(`TCP concurrency request timed out after ${body.length} bytes`));
    });
  });
}

async function withHttpServer() {
  const server = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    responseBody: 'concurrency-ok\n',
    bufferCount: 512,
    bufferSize: 2048
  });
  const info = server.start();
  try {
    await runFixedLoad(TOTAL, CONCURRENCY, () => httpOnce(info.port));
  } finally {
    server.stop();
  }
}

async function withProgrammableTcpServer() {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 512,
    bufferSize: 2048
  });
  const info = server.start((event) => {
    if (event.eventType === 'data') {
      server.sendAndClose(event.connectionId, event.data);
    }
  });
  try {
    await runFixedLoad(TOTAL, CONCURRENCY, (id) =>
      tcpOnce(info.port, Buffer.from(`js-transport-${id}`))
    );
  } finally {
    server.stop();
  }
}

async function withNativeTcpEchoServer() {
  const server = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 512,
    bufferSize: 2048
  });
  const info = server.start();
  try {
    await runFixedLoad(TOTAL, CONCURRENCY, (id) =>
      tcpOnce(info.port, Buffer.from(`native-echo-${id}`))
    );
  } finally {
    server.stop();
  }
}

(async () => {
  await withHttpServer();
  await withProgrammableTcpServer();
  await withNativeTcpEchoServer();
  console.log('concurrency regression ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
