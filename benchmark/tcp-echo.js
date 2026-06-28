'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
const BUFFER_COUNT = Number(process.env.BUFFER_COUNT || 512);
const BUFFER_SIZE = Number(process.env.BUFFER_SIZE || 2048);
const BUNDLE_REQUEST_SIZE = Number(process.env.BUNDLE_REQUEST_SIZE || 4096);
const BUNDLE_REQUEST = payload(BUNDLE_REQUEST_SIZE);
let capsCache = null;
const DEFAULT_CASES = [
  'node:net echo',
  'ferrings native tcp echo',
  'ferrings native tcp echo recv-bundle',
  'ferrings tcp echo',
  'ferrings tcp echo batch',
  'ferrings tcp echo full batch',
  'ferrings tcp facade echo',
  'ferrings tcp facade batch echo',
  'ferrings tcp echo zc',
  'ferrings native tcp echo zc',
  'ferrings native tcp echo zc recv-bundle',
  'ferrings tcp echo batch zc',
  'ferrings tcp echo full batch zc',
  'ferrings tcp facade echo zc',
  'ferrings tcp facade batch echo zc'
];
const CASES = (process.env.CASES || DEFAULT_CASES.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const CASE_ISOLATION = process.env.CASE_ISOLATION !== '0';
const CASE_REPORT_PATH = process.env.CASE_REPORT_PATH;
const REPORT_PATH = process.env.REPORT_PATH;

if (process.argv[2] === '--case') {
  runCase(process.argv[3])
    .then((result) => {
      if (CASE_REPORT_PATH) {
        fs.mkdirSync(path.dirname(CASE_REPORT_PATH), { recursive: true });
        fs.writeFileSync(CASE_REPORT_PATH, `${JSON.stringify(result, null, 2)}\n`);
      } else {
        console.log(JSON.stringify(result));
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function payload(size) {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  return data;
}

function caps() {
  if (!capsCache) {
    capsCache = capabilities();
  }
  return capsCache;
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
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE,
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
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE,
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
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE,
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
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE,
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
      bufferCount: BUFFER_COUNT,
      bufferSize: BUFFER_SIZE,
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
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE,
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
  if (!caps().recvBundle) {
    const result = {
      skipped: 'kernel does not report IORING_FEAT_RECVSEND_BUNDLE'
    };
    console.log(label, result);
    return result;
  }
  try {
    const result = await runner();
    console.log(label, result);
    return result;
  } catch (error) {
    if (/provided-buffer-ring setup was unavailable|Cannot allocate memory/i.test(error.message)) {
      const result = {
        skipped: error.message
      };
      console.log(label, result);
      return result;
    }
    throw error;
  }
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
      bufferCount: BUFFER_COUNT,
      bufferSize: BUFFER_SIZE,
      bundleRequestSize: BUNDLE_REQUEST_SIZE,
      cases: CASES
    },
    capabilities: caps(),
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

async function record(report, caseName) {
  const result = CASE_ISOLATION ? runIsolatedCase(caseName) : await runCase(caseName);
  report.results.push({ caseName, result });
  console.log(caseName, result);
}

function runIsolatedCase(caseName) {
  const caseReportPath = path.join(
    os.tmpdir(),
    `ferrings-tcp-case-${process.pid}-${Date.now()}-${caseName.replace(/[^a-z0-9]+/gi, '-')}.json`
  );
  const result = spawnSync(process.execPath, [__filename, '--case', caseName], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CASE_ISOLATION: '0',
      CASE_REPORT_PATH: caseReportPath,
      REPORT_PATH: ''
    },
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`${caseName} exited with status ${result.status ?? 1}`);
    error.caseResult = readCaseReport(caseReportPath);
    throw error;
  }
  return readCaseReport(caseReportPath);
}

function readCaseReport(caseReportPath) {
  try {
    if (!fs.existsSync(caseReportPath)) return null;
    return JSON.parse(fs.readFileSync(caseReportPath, 'utf8'));
  } finally {
    fs.rmSync(caseReportPath, { force: true });
  }
}

async function runCase(caseName) {
  switch (caseName) {
    case 'node:net echo':
      return withNodeServer();
    case 'ferrings native tcp echo':
      return withUringNativeEchoServer();
    case 'ferrings native tcp echo recv-bundle':
      return maybeRecvBundle(caseName, () =>
        withUringNativeEchoServer(
          {
            bufferSize: 512,
            useRecvBundle: true
          },
          BUNDLE_REQUEST
        )
      );
    case 'ferrings tcp echo':
      return withUringServer();
    case 'ferrings tcp echo batch':
      return withUringBatchServer();
    case 'ferrings tcp echo full batch':
      return withUringFullBatchServer();
    case 'ferrings tcp facade echo':
      return withTcpFacadeServer();
    case 'ferrings tcp facade batch echo':
      return withTcpFacadeBatchServer();
    case 'ferrings tcp echo zc':
      return withUringServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    case 'ferrings native tcp echo zc':
      return withUringNativeEchoServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    case 'ferrings native tcp echo zc recv-bundle':
      return maybeRecvBundle(caseName, () =>
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
      );
    case 'ferrings tcp echo batch zc':
      return withUringBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    case 'ferrings tcp echo full batch zc':
      return withUringFullBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    case 'ferrings tcp facade echo zc':
      return withTcpFacadeServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    case 'ferrings tcp facade batch echo zc':
      return withTcpFacadeBatchServer({
        useZeroCopySend: true,
        sendBufferCount: 512,
        sendBufferSize: 2048
      });
    default:
      throw new Error(`unknown TCP benchmark case: ${caseName}`);
  }
}

async function main() {
  const report = baseReport();
  try {
    console.log(report.config);
    for (const caseName of CASES) {
      await record(report, caseName);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = errorForReport(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
  }
}
