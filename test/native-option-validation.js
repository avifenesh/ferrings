'use strict';

const assert = require('node:assert/strict');

assertExports(require('../'), 'root');
assertExports(require('../native'), 'native');

console.log('native option validation ok');

function assertExports(exports, label) {
  const serverClasses = [
    ['UringHttpServer', exports.UringHttpServer],
    ['UringTcpEchoServer', exports.UringTcpEchoServer],
    ['UringTcpServer', exports.UringTcpServer]
  ];

  for (const [className, Server] of serverClasses) {
    const prefix = `${label} ${className}`;
    assertThrows(
      prefix,
      () => new Server({ port: 1.5 }),
      /port must be an integer between 0 and 65535/
    );
    assertThrows(
      prefix,
      () => new Server({ queueDepth: 0 }),
      /queueDepth must be an integer between 1 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ queueDepth: -1 }),
      /queueDepth must be an integer between 1 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ bufferSize: -1 }),
      /bufferSize must be an integer between 512 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ maxConnections: -1 }),
      /maxConnections must be an integer between 0 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ idleTimeoutMs: -1 }),
      /idleTimeoutMs must be an integer between 0 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ tcpDeferAcceptSeconds: -1 }),
      /tcpDeferAcceptSeconds must be an integer between 0 and 2147483647/
    );
    assertThrows(
      prefix,
      () => new Server({ socketRecvBufferSize: -1 }),
      /socketRecvBufferSize must be an integer between 0 and 2147483647/
    );
    assertThrows(
      prefix,
      () => new Server({ zcrxRxQueue: -1 }),
      /zcrxRxQueue must be an integer between 0 and 4294967295/
    );
    assertThrows(
      prefix,
      () => new Server({ zcrxRxBufferSize: -1 }),
      /zcrxRxBufferSize must be an integer between 0 and 4294967295/
    );
  }

  const TcpServer = exports.UringTcpServer;
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ commandQueueCapacity: -1 }),
    /commandQueueCapacity must be an integer between 1 and 4294967295/
  );
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ eventQueueCapacity: -1 }),
    /eventQueueCapacity must be between 1 and 65536/
  );
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ eventBatchSize: 1.5 }),
    /eventBatchSize must be between 1 and eventQueueCapacity/
  );
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ sendQueueCapacity: -1 }),
    /sendQueueCapacity must be an integer between 1 and 4294967295/
  );
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ sendBufferCount: -1 }),
    /sendBufferCount must be an integer between 1 and 65535/
  );
  assertThrows(
    `${label} UringTcpServer`,
    () => new TcpServer({ sendBufferSize: -1 }),
    /sendBufferSize must be an integer between 64 and 4294967295/
  );
}

function assertThrows(label, fn, pattern) {
  assert.throws(fn, pattern, `${label} should reject invalid native options`);
}
