'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  UringTcpEchoServer,
  UringTcpServer,
  capabilities,
  createTcpServer
} = require('../');

const REQUEST = Buffer.from('ping');
const RESPONSE = Buffer.from('pong');
const DURATION_MS = Number(process.env.DURATION_MS || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 128);
const QUEUE_DEPTH = Number(process.env.QUEUE_DEPTH || 256);
const BUNDLE_REQUEST_SIZE = Number(process.env.BUNDLE_REQUEST_SIZE || 4096);
const BUNDLE_REQUEST = payload(BUNDLE_REQUEST_SIZE);
const CAPS = capabilities();
const REPORT_PATH = process.env.REPORT_PATH;

function payload(size) {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  return data;
}

function echoOnce(port, request = REQUEST, expected = RESPONSE) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length >= expected.length) {
        socket.end();
      }
    });
    socket.on('end', () => {
      if (!body.equals(expected)) {
        reject(new Error(`unexpected response ${body.toString('hex')}`));
        return;
      }
      resolve(performance.now() - startedAt);
    });
    socket.on('error', reject);
  });
}

async function runLoad(port, request = REQUEST, expected = RESPONSE) {
  let completed = 0;
  let stopped = false;
  const latencies = [];
  const endAt = performance.now() + DURATION_MS;

  async function worker() {
    while (!stopped) {
      latencies.push(await echoOnce(port, request, expected));
      completed += 1;
      if (performance.now() >= endAt) stopped = true;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  latencies.sort((a, b) => a - b);

  return {
    requests: completed,
    rps: Math.round((completed * 1000) / DURATION_MS),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99)
  };
}

async function withNodeServer() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(RESPONSE);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await runLoad(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withUringNativeEchoServer(options = {}, request = REQUEST) {
  const server = new UringTcpEchoServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    bufferCount: 4096,
    bufferSize: 2048,
    ...options
  });

  const info = server.start();
  try {
    return {
      ...(await runLoad(info.port, request, request)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.stop();
  }
}

async function withUringServer(options = {}) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    bufferCount: 4096,
    bufferSize: 2048,
    ...options
  });

  const info = server.start((event) => {
    if (event.eventType === 'data') {
      server.sendAndClose(event.connectionId, RESPONSE);
    }
  });

  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.stop();
  }
}

async function withUringBatchServer(options = {}) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    bufferCount: 4096,
    bufferSize: 2048,
    ...options
  });

  const info = server.startBatch((events) => {
    for (const event of events) {
      if (event.eventType === 'data') {
        server.sendAndClose(event.connectionId, RESPONSE);
      }
    }
  });

  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.stop();
  }
}

async function withUringFullBatchServer(options = {}) {
  const server = new UringTcpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    bufferCount: 4096,
    bufferSize: 2048,
    ...options
  });

  const info = server.startBatch((events) => {
    const sends = [];
    for (const event of events) {
      if (event.eventType === 'data') {
        sends.push({ connectionId: event.connectionId, data: RESPONSE });
      }
    }
    if (sends.length > 0) {
      server.sendBatchAndClose(sends);
    }
  });

  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.stop();
  }
}

async function withTcpFacadeServer(options = {}) {
  const server = createTcpServer(
    {
      host: '127.0.0.1',
      port: 0,
      queueDepth: QUEUE_DEPTH,
      bufferCount: 4096,
      bufferSize: 2048,
      ...options
    },
    (connection) => {
      connection.once('data', () => {
        connection.end(RESPONSE);
      });
    }
  );

  server.listen();
  const info = server.info();
  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.close();
  }
}

async function withTcpFacadeBatchServer(options = {}) {
  const server = createTcpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    bufferCount: 4096,
    bufferSize: 2048,
    ...options
  });

  server.on('data', (connection) => {
    server.sendBatchAndClose([{ connection, data: RESPONSE }]);
  });

  server.listen();
  const info = server.info();
  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.close();
  }
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * quantile));
  return Number(values[index].toFixed(3));
}

async function maybeRecvBundle(label, runner) {
  if (!CAPS.recvBundle) {
    const result = {
      skipped: 'kernel does not report IORING_FEAT_RECVSEND_BUNDLE'
    };
    console.log(label, result);
    return result;
  }
  const result = await runner();
  console.log(label, result);
  return result;
}

function summarizeServerInfo(info) {
  if (!info) return null;
  return {
    backend: info.backend,
    backlog: info.backlog,
    queueDepth: info.queueDepth,
    bufferCount: info.bufferCount,
    bufferSize: info.bufferSize,
    tcpNoDelay: info.tcpNoDelay,
    reusePort: info.reusePort,
    tcpDeferAcceptSeconds: info.tcpDeferAcceptSeconds,
    socketRecvBufferSize: info.socketRecvBufferSize,
    socketSendBufferSize: info.socketSendBufferSize,
    multishotAccept: info.multishotAccept,
    multishotRecv: info.multishotRecv,
    providedBufferRing: info.providedBufferRing,
    recvBundle: info.recvBundle,
    recvCopyEvents: info.recvCopyEvents,
    recvCopyBytes: info.recvCopyBytes,
    eventBatchSize: info.eventBatchSize,
    sendBufferCount: info.sendBufferCount,
    sendBufferSize: info.sendBufferSize,
    registeredSendBuffer: info.registeredSendBuffer,
    fixedSendBufferMisses: info.fixedSendBufferMisses,
    fixedSendBufferMissBytes: info.fixedSendBufferMissBytes,
    zeroCopySend: info.zeroCopySend,
    zeroCopyReceive: info.zeroCopyReceive,
    zcrxReady: info.zcrxReady
  };
}

function baseReport() {
  return {
    mode: 'tcp-echo-matrix',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      durationMs: DURATION_MS,
      concurrency: CONCURRENCY,
      queueDepth: QUEUE_DEPTH,
      bundleRequestSize: BUNDLE_REQUEST_SIZE
    },
    capabilities: CAPS,
    results: [],
    error: null
  };
}

function writeReport(report) {
  if (!REPORT_PATH) return;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`TCP benchmark report written: ${REPORT_PATH}`);
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}

async function record(report, caseName, runner) {
  const result = await runner();
  report.results.push({ caseName, result });
  console.log(caseName, result);
}

(async () => {
  const report = baseReport();
  try {
    console.log(report.config);
    await record(report, 'node:net echo', withNodeServer);
    await record(report, 'ferrings native tcp echo', withUringNativeEchoServer);
    report.results.push({
      caseName: 'ferrings native tcp echo recv-bundle',
      result: await maybeRecvBundle('ferrings native tcp echo recv-bundle', () =>
        withUringNativeEchoServer(
          {
            bufferSize: 512,
            useRecvBundle: true
          },
          BUNDLE_REQUEST
        )
      )
    });
    await record(report, 'ferrings tcp echo', withUringServer);
    await record(report, 'ferrings tcp echo batch', withUringBatchServer);
    await record(report, 'ferrings tcp echo full batch', withUringFullBatchServer);
    await record(report, 'ferrings tcp facade echo', withTcpFacadeServer);
    await record(report, 'ferrings tcp facade batch echo', withTcpFacadeBatchServer);
    await record(report, 'ferrings tcp echo zc', () =>
      withUringServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    await record(report, 'ferrings native tcp echo zc', () =>
      withUringNativeEchoServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    report.results.push({
      caseName: 'ferrings native tcp echo zc recv-bundle',
      result: await maybeRecvBundle('ferrings native tcp echo zc recv-bundle', () =>
        withUringNativeEchoServer(
          {
            bufferSize: 512,
            useRecvBundle: true,
            useZeroCopySend: true,
            sendBufferCount: 512,
            sendBufferSize: Math.max(8192, BUNDLE_REQUEST_SIZE * 2)
          },
          BUNDLE_REQUEST
        )
      )
    });
    await record(report, 'ferrings tcp echo batch zc', () =>
      withUringBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    await record(report, 'ferrings tcp echo full batch zc', () =>
      withUringFullBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    await record(report, 'ferrings tcp facade echo zc', () =>
      withTcpFacadeServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    await record(report, 'ferrings tcp facade batch echo zc', () =>
      withTcpFacadeBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      })
    );
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = errorForReport(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
