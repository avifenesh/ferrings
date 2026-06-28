'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { UringHttpServer } = require('../');

const BODY = 'ok\n';
const DURATION_MS = Number(process.env.DURATION_MS || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 128);
const QUEUE_DEPTH = Number(process.env.QUEUE_DEPTH || 256);
const BUFFER_COUNT = Number(process.env.BUFFER_COUNT || 512);
const BUFFER_SIZE = Number(process.env.BUFFER_SIZE || 2048);
const REPORT_PATH = process.env.REPORT_PATH;

function requestOnce(port) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(performance.now() - startedAt));
    });
    req.on('error', reject);
  });
}

async function runLoad(port) {
  let completed = 0;
  let stopped = false;
  const latencies = [];
  const endAt = performance.now() + DURATION_MS;

  async function worker() {
    while (!stopped) {
      latencies.push(await requestOnce(port));
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

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * quantile));
  return Number(values[index].toFixed(3));
}

async function withNodeServer() {
  const server = http.createServer((_, res) => {
    res.setHeader('connection', 'close');
    res.end(BODY);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await runLoad(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withUringServer() {
  const server = new UringHttpServer({
    host: '127.0.0.1',
    port: 0,
    queueDepth: QUEUE_DEPTH,
    responseBody: BODY,
    bufferCount: BUFFER_COUNT,
    bufferSize: BUFFER_SIZE
  });

  const info = server.start();
  try {
    return {
      ...(await runLoad(info.port)),
      serverInfo: summarizeServerInfo(server.info())
    };
  } finally {
    server.stop();
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
    mode: 'http-fixed-response',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      durationMs: DURATION_MS,
      concurrency: CONCURRENCY,
      queueDepth: QUEUE_DEPTH,
      bufferCount: BUFFER_COUNT,
      bufferSize: BUFFER_SIZE
    },
    results: [],
    error: null
  };
}

function writeReport(report) {
  if (!REPORT_PATH) return;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`HTTP benchmark report written: ${REPORT_PATH}`);
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}

(async () => {
  const report = baseReport();
  try {
    console.log(report.config);
    const nodeResult = await withNodeServer();
    report.results.push({ caseName: 'node:http', result: nodeResult });
    console.log('node:http', nodeResult);
    const ferringsResult = await withUringServer();
    report.results.push({ caseName: 'ferrings', result: ferringsResult });
    console.log('ferrings', ferringsResult);
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
