'use strict';

const { UringHttpServer } = require('..');

const server = new UringHttpServer({
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 0),
  backlog: Number(process.env.BACKLOG || 1024),
  queueDepth: Number(process.env.QUEUE_DEPTH || 1024),
  bufferCount: Number(process.env.BUFFER_COUNT || 4096),
  bufferSize: Number(process.env.BUFFER_SIZE || 2048),
  responseBody: process.env.RESPONSE_BODY || 'hello from ferrings\n',
  useRegisteredSendBuffer: process.env.USE_REGISTERED_SEND_BUFFER === '1',
  useZeroCopySend: process.env.USE_ZERO_COPY_SEND === '1'
});

const info = server.start();
const keepAlive = setInterval(() => {}, 1 << 30);
console.log(JSON.stringify({ listening: `http://${info.host}:${info.port}`, info }, null, 2));

process.on('SIGINT', () => {
  server.stop();
  clearInterval(keepAlive);
});
