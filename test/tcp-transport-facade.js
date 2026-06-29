'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const createTcpTransportExports = require('../tcp-transport.js');
const {
  IoUringTcpConnection,
  IoUringTcpTransportServer,
  createTcpServer
} = require('../');

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('ping');
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  });
}

async function roundTripWithHost(port, host, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(payload);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  });
}

function getConnectionCount(server) {
  return new Promise((resolve, reject) => {
    const returned = server.getConnections((error, count) => {
      if (error) {
        reject(error);
      } else {
        resolve(count);
      }
    });
    assert.equal(returned, server);
  });
}

async function verifyFacadeKeepsProcessAlive() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
      const { createTcpServer } = require(${JSON.stringify(process.cwd())});
      const server = createTcpServer((connection) => {
        connection.on('data', (data) => {
          connection.end('alive:' + data.toString('utf8'));
          setTimeout(() => server.close(), 20);
        });
      });
      server.listen(0, '127.0.0.1', (info) => {
        console.log(JSON.stringify({ port: info.port }));
      });
      `
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`facade lifecycle child did not print readiness; stderr=${stderr}`));
    }, 3000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      try {
        const parsed = JSON.parse(output);
        clearTimeout(timer);
        resolve(parsed);
      } catch {}
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`facade lifecycle child exited before readiness code=${code} signal=${signal}; stderr=${stderr}`));
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await roundTripWithHost(ready.port, '127.0.0.1', 'process');
  assert.equal(response, 'alive:process');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`facade lifecycle child did not exit after close; stderr=${stderr}`));
    }, 3000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`facade lifecycle child exited code=${code} signal=${signal}; stderr=${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

function verifyClosedFacadeIgnoresLateNativeEvents() {
  let nativeCallback = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  const events = [];

  server.on('connection', () => {
    events.push('connection');
  });
  server.on('data', () => {
    events.push('data');
  });
  server.on('connectionClose', () => {
    events.push('connectionClose');
  });
  server.on('close', () => {
    events.push('close');
  });

  server.listen();
  assert.equal(typeof nativeCallback, 'function');
  assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: 12345 });

  server.close();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    },
    {
      eventType: 'data',
      connectionId: 1,
      data: Buffer.from('late')
    },
    {
      eventType: 'close',
      connectionId: 1
    }
  ]);

  assert.deepEqual(events, ['close']);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyFailedStartCleansFacadeState() {
  let nativeInstance = null;

  class FailingNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch() {
      throw new Error('synthetic listen failure');
    }

    stop() {
      this.stopped = true;
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'stale'
      };
    }
  }

  const { createTcpServer: createFailingTcpServer } =
    createTcpTransportExports(FailingNativeTcpServer);
  const server = createFailingTcpServer();
  assert.throws(() => server.listen(), /synthetic listen failure/);
  assert.ok(nativeInstance);
  assert.equal(nativeInstance.stopped, true);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyStartupCallbackFailureCleansFacadeState() {
  let nativeInstance = null;

  class FakeNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {
      this.stopped = true;
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'stale',
        activeConnections: 0
      };
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let closeEventCalled = false;

  server.on('close', () => {
    closeEventCalled = true;
  });

  assert.throws(
    () =>
      server.listen(() => {
        throw new Error('synthetic listen callback failure');
      }),
    /synthetic listen callback failure/
  );
  assert.ok(nativeInstance);
  assert.equal(nativeInstance.stopped, true);
  assert.equal(closeEventCalled, true);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyListeningEventFailureCleansFacadeState() {
  let nativeInstance = null;

  class FakeNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {
      this.stopped = true;
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'stale',
        activeConnections: 0
      };
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let closeEventCalled = false;

  server.on('listening', () => {
    throw new Error('synthetic listening event failure');
  });
  server.on('close', () => {
    closeEventCalled = true;
  });

  assert.throws(() => server.listen(), /synthetic listening event failure/);
  assert.ok(nativeInstance);
  assert.equal(nativeInstance.stopped, true);
  assert.equal(closeEventCalled, true);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyFrozenStartupErrorSurvivesCleanupFailure() {
  let nativeInstance = null;

  class FailingStopNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {
      this.stopped = true;
      throw new Error('synthetic startup cleanup stop failure');
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'stale',
        activeConnections: 0
      };
    }
  }

  const { createTcpServer: createFailingStopTcpServer } =
    createTcpTransportExports(FailingStopNativeTcpServer);
  const server = createFailingStopTcpServer();
  const startupError = new Error('synthetic frozen startup failure');
  Object.freeze(startupError);
  let caught = null;

  try {
    server.listen(() => {
      throw startupError;
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, startupError);
  assert.ok(nativeInstance);
  assert.equal(nativeInstance.stopped, true);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyCloseCleansStateBeforeConnectionCloseListeners() {
  let nativeCallback = null;
  let nativeInstance = null;

  class FakeNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    stop() {
      this.stopped = true;
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let closeListenerSawCleanState = false;
  let closeCallbackCalled = false;
  let serverCloseEventCalled = false;

  server.on('connection', (connection) => {
    connection.on('close', () => {
      closeListenerSawCleanState = true;
      assert.equal(connection.destroyed, true);
      assert.equal(nativeInstance.stopped, true);
      assert.equal(server.info(), null);
      assert.equal(server.address(), null);
      assert.deepEqual(server.connections(), []);
      throw new Error('synthetic connection close listener failure');
    });
  });
  server.on('close', () => {
    serverCloseEventCalled = true;
  });

  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.throws(
    () =>
      server.close(() => {
        closeCallbackCalled = true;
      }),
    /synthetic connection close listener failure/
  );
  assert.equal(closeListenerSawCleanState, true);
  assert.equal(closeCallbackCalled, true);
  assert.equal(serverCloseEventCalled, true);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyCloseCleansStateWhenNativeStopThrows() {
  class FailingStopNativeTcpServer {
    startBatch() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {
      throw new Error('synthetic native stop failure');
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'stale',
        activeConnections: 0
      };
    }
  }

  const { createTcpServer: createFailingStopTcpServer } =
    createTcpTransportExports(FailingStopNativeTcpServer);
  const server = createFailingStopTcpServer();
  const events = [];

  server.on('close', () => {
    events.push('close');
  });

  server.listen();
  assert.throws(() => server.close(), /synthetic native stop failure/);
  assert.deepEqual(events, ['close']);
  assert.equal(server.info(), null);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
}

function verifyCloseRejectsInvalidCallbackBeforeCleanup() {
  let nativeInstance = null;

  class FakeNativeTcpServer {
    constructor() {
      nativeInstance = this;
      this.stopped = false;
    }

    startBatch() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }

    stop() {
      this.stopped = true;
    }

    info() {
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 0
      };
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  server.listen();

  assert.throws(() => server.close('bad-callback'), /callback must be a function/);
  assert.ok(nativeInstance);
  assert.equal(nativeInstance.stopped, false);
  assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: 12345 });
  assert.equal(server.info().backend, 'fake');

  server.close();
  assert.equal(nativeInstance.stopped, true);
  assert.equal(server.address(), null);
}

function verifyNativeBatchCompletesAfterThrowingEventListeners() {
  let nativeCallback = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  const events = [];
  let connection = null;

  server.on('connection', (connected) => {
    events.push('connection');
    connection = connected;
    connected.on('data', (data) => {
      events.push(`connection-data:${data.toString('utf8')}`);
      throw new Error('synthetic connection data listener failure');
    });
    connected.on('close', () => {
      events.push('connection-close');
      throw new Error('synthetic connection close listener failure');
    });
    throw new Error('synthetic connection listener failure');
  });
  server.on('data', (_connection, data) => {
    events.push(`server-data:${data.toString('utf8')}`);
  });
  server.on('connectionClose', (closed) => {
    events.push('server-connection-close');
    assert.equal(closed, connection);
    assert.equal(closed.destroyed, true);
    assert.deepEqual(server.connections(), []);
  });

  server.listen();
  assert.throws(
    () =>
      nativeCallback([
        {
          eventType: 'connect',
          connectionId: 1,
          remoteAddress: '127.0.0.1',
          remoteFamily: 'IPv4',
          remotePort: 40000
        },
        {
          eventType: 'data',
          connectionId: 1,
          data: Buffer.from('payload')
        },
        {
          eventType: 'close',
          connectionId: 1
        }
      ]),
    /synthetic connection listener failure/
  );

  assert.ok(connection);
  assert.equal(connection.destroyed, true);
  assert.deepEqual(events, [
    'connection',
    'connection-data:payload',
    'server-data:payload',
    'connection-close',
    'server-connection-close'
  ]);
  assert.deepEqual(server.connections(), []);
  server.close();
}

function verifyImplicitConnectionDataRunsWhenConnectionListenerThrows() {
  let nativeCallback = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  const events = [];
  let connection = null;

  server.on('connection', (connected) => {
    events.push('connection');
    connection = connected;
    connected.on('data', (data) => {
      events.push(`connection-data:${data.toString('utf8')}`);
    });
    throw new Error('synthetic implicit connection listener failure');
  });
  server.on('data', (_connection, data) => {
    events.push(`server-data:${data.toString('utf8')}`);
  });

  server.listen();
  assert.throws(
    () =>
      nativeCallback([
        {
          eventType: 'data',
          connectionId: 7,
          remoteAddress: '127.0.0.1',
          remoteFamily: 'IPv4',
          remotePort: 40007,
          data: Buffer.from('early')
        }
      ]),
    /synthetic implicit connection listener failure/
  );

  assert.ok(connection);
  assert.equal(connection.id, 7);
  assert.equal(connection.destroyed, false);
  assert.deepEqual(events, ['connection', 'connection-data:early', 'server-data:early']);
  assert.deepEqual(server.connections(), [connection]);
  server.close();
}

function verifyDuplicateConnectClosesPreviousConnection() {
  let nativeCallback = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  const events = [];
  const connections = [];

  server.on('connection', (connection) => {
    events.push(`connection:${connection.remotePort}`);
    connections.push(connection);
    if (connections.length === 1) {
      connection.on('close', () => {
        events.push('old-close');
        assert.equal(connection.destroyed, true);
        assert.deepEqual(server.connections(), []);
        throw new Error('synthetic duplicate close listener failure');
      });
    }
  });
  server.on('connectionClose', (connection) => {
    events.push(`server-close:${connection.remotePort}`);
    assert.equal(connection, connections[0]);
    assert.equal(connection.destroyed, true);
    assert.deepEqual(server.connections(), []);
  });

  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.equal(connections.length, 1);
  assert.equal(connections[0].destroyed, false);
  assert.deepEqual(server.connections(), [connections[0]]);
  assert.throws(
    () =>
      nativeCallback([
        {
          eventType: 'connect',
          connectionId: 1,
          remoteAddress: '127.0.0.1',
          remoteFamily: 'IPv4',
          remotePort: 40001
        }
      ]),
    /synthetic duplicate close listener failure/
  );

  assert.equal(connections.length, 2);
  assert.equal(connections[0].destroyed, true);
  assert.equal(connections[1].destroyed, false);
  assert.deepEqual(server.connections(), [connections[1]]);
  assert.deepEqual(events, [
    'connection:40000',
    'old-close',
    'server-close:40000',
    'connection:40001'
  ]);
  server.close();
}

function verifyBatchRejectsForeignConnectionObjects() {
  let firstCallback = null;
  let secondSendBatchCalls = 0;

  class FakeNativeTcpServer {
    constructor() {
      this.callback = null;
    }

    startBatch(callback) {
      this.callback = callback;
      if (!firstCallback) {
        firstCallback = callback;
      }
      return {
        host: '127.0.0.1',
        port: firstCallback === callback ? 12345 : 12346,
        backend: 'fake',
        activeConnections: 0
      };
    }

    sendBatch() {
      secondSendBatchCalls += 1;
      return true;
    }

    sendBatchAndClose() {
      secondSendBatchCalls += 1;
      return true;
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const firstServer = createFakeTcpServer();
  let firstConnection = null;
  firstServer.on('connection', (connection) => {
    firstConnection = connection;
  });
  firstServer.listen();
  firstCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  const secondServer = createFakeTcpServer();
  secondServer.listen();
  assert.ok(firstConnection);
  assert.throws(
    () => secondServer.sendBatch([{ connection: firstConnection, data: 'foreign' }]),
    /connection must belong to this server/
  );
  assert.throws(
    () => secondServer.sendBatchAndClose([{ connection: firstConnection, data: 'foreign' }]),
    /connection must belong to this server/
  );
  assert.equal(secondSendBatchCalls, 0);
  firstServer.close();
  secondServer.close();
}

function verifyBatchRefusesDestroyedConnectionObjects() {
  let nativeCallback = null;
  let sendBatchCalls = 0;
  let sendBatchAndCloseCalls = 0;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    sendBatch() {
      sendBatchCalls += 1;
      return true;
    }

    sendBatchAndClose() {
      sendBatchAndCloseCalls += 1;
      return true;
    }

    closeConnection() {
      return true;
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let connection = null;
  server.on('connection', (connected) => {
    connection = connected;
  });
  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.ok(connection);
  assert.equal(connection.destroy(), true);
  assert.equal(connection.destroyed, true);
  assert.equal(server.sendBatch([{ connection, data: 'late' }]), false);
  assert.equal(server.sendBatchAndClose([{ connection, data: 'late' }]), false);
  assert.equal(server.sendBatch([{ connection, data: Symbol('late') }]), false);
  assert.equal(server.sendBatchAndClose([{ connection, data: { invalid: true } }]), false);
  assert.equal(server.sendBatch([{ connectionId: connection.id, data: 'late-by-id' }]), false);
  assert.equal(
    server.sendBatchAndClose([{ connectionId: connection.id, data: Symbol('late-by-id') }]),
    false
  );
  assert.equal(sendBatchCalls, 0);
  assert.equal(sendBatchAndCloseCalls, 0);
  server.close();
}

function verifyBatchConnectionIdMarksTrackedConnectionDestroyed() {
  let nativeCallback = null;
  let sentBatch = null;
  let sentCloseBatch = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    sendBatch(sends) {
      sentBatch = sends;
      return true;
    }

    sendBatchAndClose(sends) {
      sentCloseBatch = sends;
      return true;
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let connection = null;
  server.on('connection', (connected) => {
    connection = connected;
  });
  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.ok(connection);
  assert.equal(server.sendBatch([{ connectionId: connection.id, data: 'write-by-id' }]), true);
  assert.deepEqual(sentBatch, [{ connectionId: connection.id, data: Buffer.from('write-by-id') }]);
  assert.equal(connection.destroyed, false);
  assert.equal(
    server.sendBatchAndClose([{ connectionId: connection.id, data: 'close-by-id' }]),
    true
  );
  assert.deepEqual(sentCloseBatch, [
    { connectionId: connection.id, data: Buffer.from('close-by-id') }
  ]);
  assert.equal(connection.destroyed, true);
  server.close();
}

function verifyBatchRejectsConnectionAndConnectionIdTogether() {
  let nativeCallback = null;
  let sendBatchCalls = 0;
  let sendBatchAndCloseCalls = 0;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    sendBatch() {
      sendBatchCalls += 1;
      return true;
    }

    sendBatchAndClose() {
      sendBatchAndCloseCalls += 1;
      return true;
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let connection = null;
  server.on('connection', (connected) => {
    connection = connected;
  });
  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.ok(connection);
  assert.throws(
    () => server.sendBatch([{ connection, connectionId: 2, data: 'ambiguous' }]),
    /either connection or connectionId, not both/
  );
  assert.throws(
    () => server.sendBatchAndClose([{ connection, connectionId: 2, data: 'ambiguous' }]),
    /either connection or connectionId, not both/
  );
  assert.equal(connection.destroyed, false);
  assert.equal(sendBatchCalls, 0);
  assert.equal(sendBatchAndCloseCalls, 0);
  server.close();
}

function verifyConnectionIdentityFieldsAreStable() {
  let nativeCallback = null;

  class FakeNativeTcpServer {
    startBatch(callback) {
      nativeCallback = callback;
      return {
        host: '127.0.0.1',
        port: 12345,
        backend: 'fake',
        activeConnections: 1
      };
    }

    closeConnection() {
      return true;
    }

    stop() {}

    info() {
      return null;
    }
  }

  const { createTcpServer: createFakeTcpServer } = createTcpTransportExports(FakeNativeTcpServer);
  const server = createFakeTcpServer();
  let connection = null;
  server.on('connection', (connected) => {
    connection = connected;
  });
  server.listen();
  nativeCallback([
    {
      eventType: 'connect',
      connectionId: 1,
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 40000
    }
  ]);

  assert.ok(connection);
  const enumerableKeys = Object.keys(connection);
  assert.equal(enumerableKeys.includes('id'), true);
  assert.equal(enumerableKeys.includes('remoteAddress'), true);
  assert.equal(enumerableKeys.includes('remoteFamily'), true);
  assert.equal(enumerableKeys.includes('remotePort'), true);
  assert.equal(enumerableKeys.includes('destroyed'), true);
  assert.equal(enumerableKeys.includes('_server'), false);
  assert.equal(Object.getOwnPropertyDescriptor(connection, 'id').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(connection, '_server').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(connection, '_server').writable, false);
  assert.throws(() => {
    connection.id = 2;
  }, /read only property|Cannot assign/);
  assert.throws(() => {
    connection._server = {};
  }, /read only property|Cannot assign/);
  assert.equal(connection.id, 1);
  assert.equal(connection._server, server);
  assert.equal(connection.destroy(), true);
  assert.equal(connection.destroyed, true);
  server.close();
}

(async () => {
  let listeningInfo = null;
  let sawConnection = false;
  let sawServerData = false;
  let sawConnectionClose = false;
  let sawServerClose = false;

  const server = createTcpServer(
    {
      host: '127.0.0.1',
      port: 0,
      bufferCount: 256,
      bufferSize: 2048
    },
    (connection) => {
      sawConnection = true;
      assert.equal(connection instanceof IoUringTcpConnection, true);
      assert.equal(typeof connection.id, 'number');
      assert.equal(connection.remoteAddress, '127.0.0.1');
      assert.equal(connection.remoteFamily, 'IPv4');
      assert.equal(typeof connection.remotePort, 'number');
      assert.ok(connection.remotePort > 0);
      connection.on('data', (data) => {
        assert.equal(data.toString('utf8'), 'ping');
        assert.equal(connection.end(`facade:${data.toString('utf8')}`), true);
      });
    }
  );

  assert.equal(server instanceof IoUringTcpTransportServer, true);
  server.on('listening', (info) => {
    listeningInfo = info;
  });
  server.on('data', (connection, data) => {
    sawServerData = true;
    assert.equal(connection instanceof IoUringTcpConnection, true);
    assert.equal(data.toString('utf8'), 'ping');
  });
  server.on('connectionClose', () => {
    sawConnectionClose = true;
  });
  server.on('close', () => {
    sawServerClose = true;
  });

  server.listen();
  const address = server.address();
  assert.ok(address);
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  assert.equal(typeof address.port, 'number');
  assert.equal(listeningInfo.port, address.port);

  try {
    const response = await roundTrip(address.port);
    assert.equal(response, 'facade:ping');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sawConnection, true);
    assert.equal(sawServerData, true);
    assert.equal(sawConnectionClose, true);
    assert.equal(server.connections().length, 0);
    assert.equal(server.info().backend, 'io_uring');
  } finally {
    server.close();
  }

  assert.equal(sawServerClose, true);
  assert.equal(server.address(), null);

  let listenCallbackInfo = null;
  const nodeStyleServer = createTcpServer((connection) => {
    connection.on('data', (data) => {
      assert.equal(data.toString('utf8'), 'node-style');
      assert.equal(connection.end('node-style-ok'), true);
    });
  });
  nodeStyleServer.listen(0, '127.0.0.1', 7, (info) => {
    listenCallbackInfo = info;
  });
  const nodeStyleAddress = nodeStyleServer.address();
  assert.ok(nodeStyleAddress);
  assert.equal(nodeStyleAddress.address, '127.0.0.1');
  assert.equal(nodeStyleAddress.port, listenCallbackInfo.port);
  assert.equal(nodeStyleServer.info().backlog, 7);
  try {
    const response = await roundTripWithHost(nodeStyleAddress.port, nodeStyleAddress.address, 'node-style');
    assert.equal(response, 'node-style-ok');
  } finally {
    nodeStyleServer.close();
  }

  const numericHostServer = createTcpServer();
  numericHostServer.listen(0, '0');
  const numericHostAddress = numericHostServer.address();
  assert.ok(numericHostAddress);
  assert.equal(numericHostAddress.address, '0.0.0.0');
  assert.equal(numericHostServer.info().backlog, 1024);
  numericHostServer.close();

  let startCallbackInfo = null;
  const startOptionsServer = createTcpServer();
  const startOptionsInfo = startOptionsServer.start(
    {
      host: '127.0.0.1',
      port: 0,
      backlog: 11
    },
    (info) => {
      startCallbackInfo = info;
    }
  );
  assert.ok(startOptionsInfo);
  assert.equal(startOptionsInfo.port, startCallbackInfo.port);
  assert.equal(startOptionsServer.address().port, startOptionsInfo.port);
  assert.equal(startOptionsServer.info().backlog, 11);
  startOptionsServer.close();

  const batchFacadeServer = createTcpServer();
  batchFacadeServer.on('data', (connection, data) => {
    const request = data.toString('utf8');
    if (request === 'batch-write') {
      assert.equal(
        batchFacadeServer.sendBatch([
          { connection, data: 'batch:' },
          { connectionId: connection.id, data: Buffer.from('write:') }
        ]),
        true
      );
      assert.equal(connection.end('done'), true);
    } else if (request === 'batch-close') {
      assert.equal(
        batchFacadeServer.sendBatchAndClose([
          { connection, data: 'batch:' },
          { connectionId: connection.id, data: new Uint8Array(Buffer.from('close')) }
        ]),
        true
      );
      assert.equal(connection.destroyed, true);
    } else {
      throw new Error(`unexpected batch facade request ${request}`);
    }
  });
  batchFacadeServer.listen(0, '127.0.0.1');
  const batchFacadeAddress = batchFacadeServer.address();
  assert.ok(batchFacadeAddress);
  try {
    assert.equal(
      await roundTripWithHost(batchFacadeAddress.port, batchFacadeAddress.address, 'batch-write'),
      'batch:write:done'
    );
    assert.equal(
      await roundTripWithHost(batchFacadeAddress.port, batchFacadeAddress.address, 'batch-close'),
      'batch:close'
    );
    assert.throws(
      () => batchFacadeServer.sendBatch([{ data: 'missing connection' }]),
      /connectionId must be a uint32/
    );
    assert.throws(
      () => batchFacadeServer.sendBatch([Buffer.from('not-a-send-record')]),
      /each send must be an object/
    );
    assert.throws(
      () => batchFacadeServer.sendBatchAndClose([new Date()]),
      /each send must be an object/
    );
  } finally {
    batchFacadeServer.close();
  }

  const nullPrototypeConstructorOptions = Object.create(null);
  nullPrototypeConstructorOptions.host = '127.0.0.1';
  nullPrototypeConstructorOptions.port = 0;
  const nullPrototypeConstructorServer = createTcpServer(nullPrototypeConstructorOptions);
  nullPrototypeConstructorServer.listen();
  assert.equal(nullPrototypeConstructorServer.address().address, '127.0.0.1');
  nullPrototypeConstructorServer.close();

  const nullPrototypeListenOptions = Object.create(null);
  nullPrototypeListenOptions.host = '127.0.0.1';
  nullPrototypeListenOptions.port = 0;
  const nullPrototypeListenServer = createTcpServer();
  nullPrototypeListenServer.listen(nullPrototypeListenOptions);
  assert.equal(nullPrototypeListenServer.address().address, '127.0.0.1');
  nullPrototypeListenServer.close();

  class NonPlainOptions {}

  assert.throws(
    () => createTcpServer().getConnections(null),
    /callback must be a function/
  );
  assert.throws(
    () => createTcpServer('bad'),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer(42),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer([]),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer(Buffer.from('bad-options')),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer(new Date()),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer(new NonPlainOptions()),
    /options must be an object/
  );
  assert.throws(
    () => createTcpServer({}, 'bad-listener'),
    /connectionListener must be a function/
  );
  assert.throws(
    () => createTcpServer(null, 'bad-listener'),
    /connectionListener must be a function/
  );
  assert.throws(
    () => createTcpServer().start(0),
    /start options must be an object/
  );
  assert.throws(
    () => createTcpServer().start('bad'),
    /start options must be an object/
  );
  assert.throws(
    () => createTcpServer().start(0, '127.0.0.1'),
    /callback must be a function/
  );
  assert.throws(
    () => createTcpServer().start({}, 'bad-callback'),
    /callback must be a function/
  );
  assert.throws(
    () => createTcpServer().start({}, () => {}, 'extra'),
    /start accepts at most options and callback arguments/
  );
  assert.throws(
    () => createTcpServer().start(Buffer.from('bad-start-options')),
    /start options must be an object/
  );
  assert.throws(
    () => createTcpServer().listen('bad'),
    /port must be an integer between 0 and 65535/
  );
  assert.throws(
    () => createTcpServer().listen(NaN),
    /port must be an integer between 0 and 65535/
  );
  assert.throws(
    () => createTcpServer().listen(-1),
    /port must be an integer between 0 and 65535/
  );
  assert.throws(
    () => createTcpServer().listen(1.5),
    /port must be an integer between 0 and 65535/
  );
  assert.throws(
    () => createTcpServer().listen(Buffer.from('bad-listen-options')),
    /listen options must be an object/
  );
  assert.throws(
    () => createTcpServer().listen(new Date()),
    /listen options must be an object/
  );
  assert.throws(
    () => createTcpServer().listen(new NonPlainOptions()),
    /listen options must be an object/
  );
  assert.throws(
    () => createTcpServer().listen([]),
    /listen options must be an object/
  );
  assert.throws(
    () => createTcpServer().listen(0, '127.0.0.1', 0),
    /backlog must be an integer between 1 and 2147483647/
  );
  assert.throws(
    () => createTcpServer().listen(0, {}),
    /backlog must be a number/
  );
  assert.throws(
    () => createTcpServer().listen(0, {}, 128),
    /host must be a string/
  );
  assert.throws(
    () => createTcpServer().listen(0, '127.0.0.1', 128, 'extra'),
    /at most port, host, and backlog/
  );
  assert.throws(
    () => createTcpServer().listen(0, '127.0.0.1', 128, 'extra', () => {}),
    /at most port, host, and backlog/
  );
  assert.throws(
    () => createTcpServer().listen({ port: 0 }, '127.0.0.1'),
    /options object cannot be combined with positional arguments/
  );
  assert.throws(
    () => createTcpServer().listen({ port: 0 }, 128, () => {}),
    /options object cannot be combined with positional arguments/
  );
  assert.throws(
    () => createTcpServer({ port: 'bad' }).listen(),
    /port must be an integer between 0 and 65535/
  );
  assert.throws(
    () => createTcpServer({ host: 127 }).listen(),
    /host must be a string/
  );

  const countServer = createTcpServer();
  countServer.on('data', (connection) => {
    connection.end('held');
  });
  countServer.listen(0, '127.0.0.1');
  const countAddress = countServer.address();
  assert.ok(countAddress);
  try {
    assert.equal(await getConnectionCount(countServer), 0);
    const heldSocket = net.createConnection({
      host: countAddress.address,
      port: countAddress.port
    });
    await new Promise((resolve, reject) => {
      heldSocket.once('connect', resolve);
      heldSocket.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await getConnectionCount(countServer), 1);
    const releaseResponse = new Promise((resolve, reject) => {
      let body = '';
      heldSocket.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      heldSocket.once('end', () => resolve(body));
      heldSocket.once('error', reject);
    });
    heldSocket.end('release');
    assert.equal(await releaseResponse, 'held');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await getConnectionCount(countServer), 0);
  } finally {
    countServer.close();
  }

  await verifyFacadeKeepsProcessAlive();
  verifyClosedFacadeIgnoresLateNativeEvents();
  verifyFailedStartCleansFacadeState();
  verifyStartupCallbackFailureCleansFacadeState();
  verifyListeningEventFailureCleansFacadeState();
  verifyFrozenStartupErrorSurvivesCleanupFailure();
  verifyCloseCleansStateBeforeConnectionCloseListeners();
  verifyCloseCleansStateWhenNativeStopThrows();
  verifyCloseRejectsInvalidCallbackBeforeCleanup();
  verifyNativeBatchCompletesAfterThrowingEventListeners();
  verifyImplicitConnectionDataRunsWhenConnectionListenerThrows();
  verifyDuplicateConnectClosesPreviousConnection();
  verifyBatchRejectsForeignConnectionObjects();
  verifyBatchRefusesDestroyedConnectionObjects();
  verifyBatchConnectionIdMarksTrackedConnectionDestroyed();
  verifyBatchRejectsConnectionAndConnectionIdTogether();
  verifyConnectionIdentityFieldsAreStable();

  console.log('tcp transport facade ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
