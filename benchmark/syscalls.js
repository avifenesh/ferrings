'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const {
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer,
  capabilities,
  createTcpServer
} = require('../');

const BODY = 'ok\n';
const TCP_REQUEST = Buffer.from('ping');
const TCP_RESPONSE = Buffer.from('pong');
const REQUESTS = Number(process.env.REQUESTS || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 32);
const QUEUE_DEPTH = Number(process.env.QUEUE_DEPTH || 256);
const BUNDLE_REQUEST_SIZE = Number(process.env.BUNDLE_REQUEST_SIZE || 4096);
const BUNDLE_REQUEST = payload(BUNDLE_REQUEST_SIZE);
const CAPS = capabilities();
const DEFAULT_CASES = [
  'node-http',
  'ferrings-http',
  'node-tcp',
  'ferrings-tcp',
  'ferrings-tcp-facade',
  'ferrings-tcp-facade-batch',
  'ferrings-native-tcp'
];
if (CAPS.sendZc) {
  DEFAULT_CASES.push(
    'ferrings-http-zc',
    'ferrings-tcp-zc',
    'ferrings-tcp-facade-zc',
    'ferrings-tcp-facade-batch-zc',
    'ferrings-native-tcp-zc'
  );
}
if (CAPS.recvBundle) {
  DEFAULT_CASES.push('ferrings-native-tcp-recv-bundle');
  if (CAPS.sendZc) {
    DEFAULT_CASES.push('ferrings-native-tcp-zc-recv-bundle');
  }
}
const CASES = (process.env.CASES || DEFAULT_CASES.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const REPORT_PATH = process.env.REPORT_PATH;

if (process.argv[2] === '--serve') {
  serveCase(process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  const report = baseReport();
  try {
    const strace = spawnSync('strace', ['-V'], { encoding: 'utf8' });
    if (strace.error || strace.status !== 0) {
      throw new Error('strace is required for bench:syscalls');
    }

    console.log(report.config);
    for (const caseName of CASES) {
      const result = await traceServerCase(caseName);
      report.results.push({ caseName, result });
      console.log(caseName, result);
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

function baseReport() {
  return {
    mode: 'syscalls',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      requests: REQUESTS,
      concurrency: CONCURRENCY,
      queueDepth: QUEUE_DEPTH,
      bundleRequestSize: BUNDLE_REQUEST_SIZE,
      cases: CASES
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
  console.log(`syscall benchmark report written: ${REPORT_PATH}`);
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}

async function traceServerCase(caseName) {
  const summaryPath = path.join(
    os.tmpdir(),
    `ferrings-strace-${process.pid}-${caseName}-${Date.now()}.txt`
  );
  const child = spawn(
    'strace',
    ['-qq', '-f', '-c', '-o', summaryPath, process.execPath, __filename, '--serve', caseName],
    {
      stdio: ['pipe', 'pipe', 'inherit']
    }
  );

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const ready = await waitForReady(child, caseName);
  const load = await runFixedLoad(caseName, ready.port);
  child.stdin.end('stop\n');
  const exit = await withTimeout(exitPromise, 2000, `timed out stopping ${caseName}`);
  if (exit.code !== 0) {
    throw new Error(`${caseName} strace server exited with code ${exit.code} signal ${exit.signal}`);
  }
  if (!exited) {
    child.kill('SIGKILL');
  }

  const syscalls = parseStraceSummary(fs.readFileSync(summaryPath, 'utf8'));
  fs.rmSync(summaryPath, { force: true });
  return {
    ...load,
    serverInfo: summarizeServerInfo(ready.info),
    totalSyscalls: syscalls.total,
    syscallsPerConnection: Number((syscalls.total / load.requests).toFixed(3)),
    keySyscalls: selectKeySyscalls(syscalls.calls)
  };
}

function waitForReady(child, caseName) {
  const rl = readline.createInterface({ input: child.stdout });
  return withTimeout(
    new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => {
        reject(new Error(`${caseName} exited before ready: code=${code} signal=${signal}`));
      });
      rl.once('line', (line) => {
        try {
          const ready = JSON.parse(line);
          if (!ready.port) {
            reject(new Error(`${caseName} did not report a port`));
            return;
          }
          resolve(ready);
        } catch (error) {
          reject(new Error(`${caseName} printed invalid ready line: ${line}: ${error.message}`));
        }
      });
    }),
    2000,
    `timed out waiting for ${caseName} to listen`
  );
}

async function serveCase(caseName) {
  const server = await startServer(caseName);
  console.log(JSON.stringify({ port: server.port, info: server.info || null }));

  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (chunk.includes('stop')) {
        resolve();
      }
    });
    process.stdin.on('end', resolve);
  });
  await server.stop();
}

async function startServer(caseName) {
  if (caseName === 'node-http') {
    const server = http.createServer((_, res) => {
      res.setHeader('connection', 'close');
      res.end(BODY);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: server.address().port,
      stop: () => new Promise((resolve) => server.close(resolve))
    };
  }

  if (caseName === 'ferrings-http' || caseName === 'ferrings-http-zc') {
    const server = new UringHttpServer({
      host: '127.0.0.1',
      port: 0,
      queueDepth: QUEUE_DEPTH,
      responseBody: BODY,
      bufferCount: 4096,
      bufferSize: 2048,
      useZeroCopySend: caseName === 'ferrings-http-zc'
    });
    const info = server.start();
    return {
      port: info.port,
      info,
      stop: () => {
        server.stop();
      }
    };
  }

  if (caseName === 'node-tcp') {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.end(TCP_RESPONSE);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: server.address().port,
      stop: () => new Promise((resolve) => server.close(resolve))
    };
  }

  if (caseName === 'ferrings-tcp' || caseName === 'ferrings-tcp-zc') {
    const server = new UringTcpServer({
      host: '127.0.0.1',
      port: 0,
      queueDepth: QUEUE_DEPTH,
      bufferCount: 4096,
      bufferSize: 2048,
      useZeroCopySend: caseName === 'ferrings-tcp-zc',
      sendBufferCount: 512,
      sendBufferSize: 2048
    });
    const info = server.start((event) => {
      if (event.eventType === 'data') {
        server.sendAndClose(event.connectionId, TCP_RESPONSE);
      }
    });
    return {
      port: info.port,
      info,
      stop: () => {
        server.stop();
      }
    };
  }

  if (caseName.startsWith('ferrings-tcp-facade')) {
    const useBatch = caseName.includes('-batch');
    const useZeroCopySend = caseName.endsWith('-zc');
    const server = createTcpServer({
      host: '127.0.0.1',
      port: 0,
      queueDepth: QUEUE_DEPTH,
      bufferCount: 4096,
      bufferSize: 2048,
      useZeroCopySend,
      sendBufferCount: 512,
      sendBufferSize: 2048
    });
    if (useBatch) {
      server.on('data', (connection) => {
        server.sendBatchAndClose([{ connection, data: TCP_RESPONSE }]);
      });
    } else {
      server.on('connection', (connection) => {
        connection.once('data', () => {
          connection.end(TCP_RESPONSE);
        });
      });
    }
    server.listen();
    const info = server.info();
    return {
      port: info.port,
      info,
      stop: () => {
        server.close();
      }
    };
  }

  if (caseName.startsWith('ferrings-native-tcp')) {
    const useRecvBundle = caseName.endsWith('-recv-bundle');
    const useZeroCopySend =
      caseName === 'ferrings-native-tcp-zc' ||
      caseName === 'ferrings-native-tcp-zc-recv-bundle';
    if (useRecvBundle && !CAPS.recvBundle) {
      throw new Error(
        `${caseName} requires IORING_FEAT_RECVSEND_BUNDLE but capabilities().recvBundle is false`
      );
    }
    const server = new UringTcpEchoServer({
      host: '127.0.0.1',
      port: 0,
      queueDepth: QUEUE_DEPTH,
      bufferCount: 4096,
      bufferSize: useRecvBundle ? 512 : 2048,
      useRecvBundle,
      useZeroCopySend,
      sendBufferCount: 512,
      sendBufferSize: useRecvBundle ? Math.max(8192, BUNDLE_REQUEST_SIZE * 2) : 2048
    });
    const info = server.start();
    return {
      port: info.port,
      info,
      stop: () => {
        server.stop();
      }
    };
  }

  throw new Error(`unknown syscall benchmark case: ${caseName}`);
}

async function runFixedLoad(caseName, port) {
  const latencies = [];
  let next = 0;
  const startedAt = performance.now();

  async function worker() {
    while (next < REQUESTS) {
      next += 1;
      const latency = isHttpCase(caseName)
        ? await httpOnce(port)
        : await tcpOnce(port, tcpRequest(caseName), expectedTcpResponse(caseName));
      latencies.push(latency);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, worker));
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  return {
    requests: latencies.length,
    rps: Math.round((latencies.length * 1000) / durationMs),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99)
  };
}

function httpOnce(port) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(performance.now() - startedAt));
    });
    req.on('error', reject);
  });
}

function tcpOnce(port, request = TCP_REQUEST, expected = TCP_RESPONSE) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      if (!body.equals(expected)) {
        reject(new Error(`unexpected TCP response ${body.toString('hex')}`));
        return;
      }
      resolve(performance.now() - startedAt);
    });
    socket.on('error', reject);
  });
}

function parseStraceSummary(summary) {
  const calls = {};
  for (const line of summary.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0] === '%' || columns[columns.length - 1] === 'total') {
      continue;
    }
    const syscall = columns[columns.length - 1];
    const callCount = Number(columns[3]);
    if (Number.isFinite(callCount)) {
      calls[syscall] = (calls[syscall] || 0) + callCount;
    }
  }
  const total = Object.values(calls).reduce((sum, count) => sum + count, 0);
  return { calls, total };
}

function selectKeySyscalls(calls) {
  const keys = [
    'io_uring_enter',
    'io_uring_setup',
    'io_uring_register',
    'epoll_wait',
    'epoll_pwait',
    'epoll_pwait2',
    'epoll_ctl',
    'accept4',
    'recvfrom',
    'sendto',
    'read',
    'write',
    'close',
    'futex'
  ];
  return Object.fromEntries(keys.filter((key) => calls[key]).map((key) => [key, calls[key]]));
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * quantile));
  return Number(values[index].toFixed(3));
}

function isHttpCase(caseName) {
  return caseName === 'node-http' || caseName.startsWith('ferrings-http');
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
    zcrxReady: info.zcrxReady,
    zcrxRxBufferSize: info.zcrxRxBufferSize,
    zcrxPackets: info.zcrxPackets,
    zcrxBytes: info.zcrxBytes
  };
}

function tcpRequest(caseName) {
  return caseName.endsWith('-recv-bundle') ? BUNDLE_REQUEST : TCP_REQUEST;
}

function expectedTcpResponse(caseName) {
  return caseName.startsWith('ferrings-native-tcp') ? tcpRequest(caseName) : TCP_RESPONSE;
}

function payload(size) {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  return data;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
