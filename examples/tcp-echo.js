'use strict';

const { createTcpServer } = require('..');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => {
    connection.end(data);
  });
});

server.listen(
  {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 0),
    backlog: Number(process.env.BACKLOG || 1024),
    queueDepth: Number(process.env.QUEUE_DEPTH || 1024),
    bufferCount: Number(process.env.BUFFER_COUNT || 4096),
    bufferSize: Number(process.env.BUFFER_SIZE || 2048),
    useRecvBundle: process.env.USE_RECV_BUNDLE === '1',
    useZeroCopySend: process.env.USE_ZERO_COPY_SEND === '1'
  },
  (info) => {
    console.log(JSON.stringify({ listening: `tcp://${info.host}:${info.port}`, info }, null, 2));
  }
);

process.on('SIGINT', () => {
  server.close();
});
