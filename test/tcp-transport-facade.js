'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
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
  } finally {
    batchFacadeServer.close();
  }

  assert.throws(
    () => createTcpServer().getConnections(null),
    /callback must be a function/
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

  console.log('tcp transport facade ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
