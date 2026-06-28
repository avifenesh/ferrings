'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer,
  createTcpServer
} = require('../');

const RECV_BUFFER_SIZE = 65536;
const SEND_BUFFER_SIZE = 65536;

function httpRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
  });
}

function tcpRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(payload);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error(`timed out after ${body.length} response bytes`));
    });
  });
}

function socketBufferOptions() {
  return {
    socketRecvBufferSize: RECV_BUFFER_SIZE,
    socketSendBufferSize: SEND_BUFFER_SIZE
  };
}

function assertSocketBufferInfo(info) {
  assert.equal(info.socketRecvBufferSize, RECV_BUFFER_SIZE);
  assert.equal(info.socketSendBufferSize, SEND_BUFFER_SIZE);
}

(async () => {
  const defaultServer = new UringTcpServer({ host: '127.0.0.1', port: 0 });
  const defaultInfo = defaultServer.start(() => {});
  try {
    assert.equal(defaultInfo.socketRecvBufferSize, 0);
    assert.equal(defaultInfo.socketSendBufferSize, 0);
  } finally {
    defaultServer.stop();
  }

  assert.throws(
    () => new UringTcpServer({ socketRecvBufferSize: 2147483648 }),
    /socketRecvBufferSize must be <=/
  );
  assert.throws(
    () => new UringHttpServer({ socketSendBufferSize: 2147483648 }),
    /socketSendBufferSize must be <=/
  );

  const httpServer = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    responseBody: 'socket-buffer-http\n',
    bufferCount: 256,
    bufferSize: 2048,
    ...socketBufferOptions()
  });
  const httpInfo = httpServer.start();
  try {
    assertSocketBufferInfo(httpInfo);
    assertSocketBufferInfo(httpServer.info());
    assert.equal(await httpRequest(httpInfo.port), 'socket-buffer-http\n');
  } finally {
    httpServer.stop();
  }

  const tcpServer = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    ...socketBufferOptions()
  });
  const tcpInfo = tcpServer.start((event) => {
    if (event.eventType === 'data') {
      tcpServer.sendAndClose(event.connectionId, Buffer.from('socket-buffer-tcp'));
    }
  });
  try {
    assertSocketBufferInfo(tcpInfo);
    assertSocketBufferInfo(tcpServer.info());
    assert.equal(await tcpRoundTrip(tcpInfo.port, 'ping'), 'socket-buffer-tcp');
  } finally {
    tcpServer.stop();
  }

  const echoServer = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    ...socketBufferOptions()
  });
  const echoInfo = echoServer.start();
  try {
    assertSocketBufferInfo(echoInfo);
    assertSocketBufferInfo(echoServer.info());
    assert.equal(await tcpRoundTrip(echoInfo.port, 'socket-buffer-echo'), 'socket-buffer-echo');
  } finally {
    echoServer.stop();
  }

  const facadeServer = createTcpServer({
    host: '127.0.0.1',
    port: 0,
    bufferCount: 256,
    bufferSize: 2048,
    ...socketBufferOptions()
  });
  facadeServer.on('data', (connection, data) => {
    connection.end(`socket-buffer-facade:${data.toString('utf8')}`);
  });
  facadeServer.listen();
  try {
    const info = facadeServer.info();
    assertSocketBufferInfo(info);
    assert.equal(
      await tcpRoundTrip(info.port, 'ok'),
      'socket-buffer-facade:ok'
    );
  } finally {
    facadeServer.close();
  }

  console.log('socket buffer size ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
