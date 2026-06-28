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

(async () => {
  const defaultServer = new UringTcpServer({ host: '127.0.0.1', port: 0 });
  const defaultInfo = defaultServer.start(() => {});
  try {
    assert.equal(defaultInfo.tcpNoDelay, true);
    assert.equal(defaultServer.info().tcpNoDelay, true);
  } finally {
    defaultServer.stop();
  }

  const httpServer = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    tcpNoDelay: false,
    responseBody: 'nodelay-http\n',
    bufferCount: 256,
    bufferSize: 2048
  });
  const httpInfo = httpServer.start();
  try {
    assert.equal(httpInfo.tcpNoDelay, false);
    assert.equal(httpServer.info().tcpNoDelay, false);
    assert.equal(await httpRequest(httpInfo.port), 'nodelay-http\n');
  } finally {
    httpServer.stop();
  }

  const tcpServer = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    tcpNoDelay: false,
    bufferCount: 256,
    bufferSize: 2048
  });
  const tcpInfo = tcpServer.start((event) => {
    if (event.eventType === 'data') {
      tcpServer.sendAndClose(event.connectionId, Buffer.from('nodelay-tcp'));
    }
  });
  try {
    assert.equal(tcpInfo.tcpNoDelay, false);
    assert.equal(tcpServer.info().tcpNoDelay, false);
    assert.equal(await tcpRoundTrip(tcpInfo.port, 'ping'), 'nodelay-tcp');
  } finally {
    tcpServer.stop();
  }

  const echoServer = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    tcpNoDelay: false,
    bufferCount: 256,
    bufferSize: 2048
  });
  const echoInfo = echoServer.start();
  try {
    assert.equal(echoInfo.tcpNoDelay, false);
    assert.equal(echoServer.info().tcpNoDelay, false);
    assert.equal(await tcpRoundTrip(echoInfo.port, 'nodelay-echo'), 'nodelay-echo');
  } finally {
    echoServer.stop();
  }

  const facadeServer = createTcpServer({
    host: '127.0.0.1',
    port: 0,
    tcpNoDelay: false,
    bufferCount: 256,
    bufferSize: 2048
  });
  facadeServer.on('data', (connection, data) => {
    connection.end(`nodelay-facade:${data.toString('utf8')}`);
  });
  facadeServer.listen();
  try {
    const info = facadeServer.info();
    assert.equal(info.tcpNoDelay, false);
    assert.equal(
      await tcpRoundTrip(info.port, 'ok'),
      'nodelay-facade:ok'
    );
  } finally {
    facadeServer.close();
  }

  console.log('tcp nodelay ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
