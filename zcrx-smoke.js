'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer,
  zcrxProbe
} = require('./');

async function runZcrxHardwareSmoke(options = {}) {
  const config = normalizeSmokeOptions(options);
  const report = baseReport(config);

  try {
    if (config.selfTest) {
      runQueueStatsParserSelfTest();
      report.status = 'self-test';
      return report;
    }

    if (!config.interfaceName) {
      report.status = 'skipped';
      report.skippedReason = 'set ZCRX_INTERFACE or pass --interface before running this hardware test';
      return report;
    }

    const probe = zcrxProbe({
      interfaceName: config.interfaceName,
      rxQueue: config.rxQueue,
      rxBufferSize: config.rxBufferSize,
      activeRegistration: true
    });
    report.probe = probe;

    const activeSucceeded =
      probe.activeRegistrationErrno === undefined &&
      /succeeded/i.test(probe.activeRegistrationResult || '');
    if (!activeSucceeded) {
      throw new Error(`ZCRX active registration failed: ${probe.blockers.join('; ')}`);
    }
    if (!probe.ready) {
      report.warnings.push(
        `passive readiness blockers remain: ${probe.blockers.join('; ')}`
      );
    }

    const queueCountersBefore = readSelectedRxQueueCounters(config.interfaceName, config.rxQueue);
    report.queueCounters = {
      before: countersForReport(queueCountersBefore),
      after: null,
      positiveDeltas: []
    };
    if (!queueCountersBefore.available) {
      const message = `selected RX queue counter evidence unavailable: ${queueCountersBefore.reason}`;
      if (config.requireRxQueueStats) {
        throw new Error(message);
      }
      report.warnings.push(message);
    }

    await smokeHttp(report, config);
    await smokeNativeEcho(report, config);
    await smokeProgrammableTcp(report, config);

    if (queueCountersBefore.available) {
      const queueCountersAfter = readSelectedRxQueueCounters(config.interfaceName, config.rxQueue);
      const deltas = queueCountersAfter.available
        ? diffCounters(queueCountersBefore, queueCountersAfter)
        : [];
      const positiveDeltas = deltas.filter(({ delta }) => delta > 0n);
      report.queueCounters.after = countersForReport(queueCountersAfter);
      report.queueCounters.positiveDeltas = deltasForReport(positiveDeltas);
      if (positiveDeltas.length === 0) {
        throw new Error(
          `ZCRX traffic completed but selected RX queue ${config.rxQueue} counters did not increase; ` +
            `before counters: ${[...queueCountersBefore.counters.keys()].join(', ')}`
        );
      }
    }

    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = errorForReport(error);
    error.report = report;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport(report, config.reportPath);
  }
}

function normalizeSmokeOptions(options) {
  return {
    interfaceName: options.interfaceName || process.env.ZCRX_INTERFACE,
    rxQueue: numberOrDefault(options.rxQueue, process.env.ZCRX_RX_QUEUE, 0),
    rxBufferSize: numberOrDefault(
      options.rxBufferSize,
      process.env.ZCRX_RX_BUFFER_SIZE,
      0
    ),
    bindHost: options.bindHost || process.env.ZCRX_BIND_HOST || '0.0.0.0',
    connectHost:
      options.connectHost ||
      process.env.ZCRX_CONNECT_HOST ||
      process.env.ZCRX_BIND_HOST ||
      '127.0.0.1',
    timeoutMs: numberOrDefault(options.timeoutMs, process.env.ZCRX_TIMEOUT_MS, 5000),
    requireRxQueueStats:
      options.requireRxQueueStats !== undefined
        ? Boolean(options.requireRxQueueStats)
        : process.env.ZCRX_REQUIRE_RX_QUEUE_STATS === '1',
    reportPath: options.reportPath || process.env.ZCRX_REPORT_PATH,
    selfTest: Boolean(options.selfTest)
  };
}

function numberOrDefault(value, envValue, fallback) {
  const candidate = value !== undefined ? value : envValue;
  if (candidate === undefined || candidate === '') return fallback;
  return Number(candidate);
}

function baseReport(config) {
  return {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      interfaceName: config.interfaceName,
      rxQueue: config.rxQueue,
      rxBufferSize: config.rxBufferSize,
      bindHost: config.bindHost,
      connectHost: config.connectHost,
      timeoutMs: config.timeoutMs,
      requireRxQueueStats: config.requireRxQueueStats
    },
    warnings: [],
    probe: null,
    queueCounters: null,
    smokes: []
  };
}

function parseEthtoolStats(output) {
  const stats = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(\d+)\s*$/);
    if (!match) continue;
    stats.set(match[1].trim(), BigInt(match[2]));
  }
  return stats;
}

function isSelectedRxQueueCounter(name, queue) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const queuePatterns = [
    `rx_queue_${queue}_`,
    `rx_q${queue}_`,
    `rxq${queue}_`,
    `rx_${queue}_`,
    `rx${queue}_`,
    `queue_${queue}_rx_`,
    `queue${queue}_rx_`
  ];
  const mentionsSelectedQueue = queuePatterns.some((pattern) => normalized.includes(pattern));
  const looksLikeTraffic = /(?:^|_)(?:packets|packet|pkts|pkt|bytes|octets)(?:_|$)/.test(normalized);
  const looksLikeAuxiliary =
    /(?:^|_)(?:drop|dropped|error|errors|xdp|alloc|recycle|refill|miss|missed)(?:_|$)/.test(normalized);
  return mentionsSelectedQueue && looksLikeTraffic && !looksLikeAuxiliary;
}

function readSelectedRxQueueCounters(interfaceName, queue) {
  const output = spawnSync('ethtool', ['-S', interfaceName], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (output.error || output.status !== 0) {
    return {
      available: false,
      counters: new Map(),
      reason: output.error ? output.error.message : (output.stderr || 'ethtool -S failed').trim()
    };
  }

  const stats = parseEthtoolStats(output.stdout || '');
  const counters = new Map();
  for (const [name, value] of stats) {
    if (isSelectedRxQueueCounter(name, queue)) {
      counters.set(name, value);
    }
  }

  if (counters.size === 0) {
    return {
      available: false,
      counters,
      reason: `ethtool exposed no recognizable traffic counters for RX queue ${queue}`
    };
  }

  return { available: true, counters, reason: null };
}

function diffCounters(before, after) {
  const deltas = [];
  for (const [name, beforeValue] of before.counters) {
    const afterValue = after.counters.get(name);
    if (afterValue === undefined || afterValue < beforeValue) continue;
    const delta = afterValue - beforeValue;
    deltas.push({ name, delta });
  }
  return deltas;
}

function countersForReport(snapshot) {
  return {
    available: snapshot.available,
    reason: snapshot.reason,
    counters: Object.fromEntries(
      [...snapshot.counters].map(([name, value]) => [name, value.toString()])
    )
  };
}

function deltasForReport(deltas) {
  return deltas.map(({ name, delta }) => ({ name, delta: delta.toString() }));
}

function assertZcrxTransportStats(smoke, info, minBytes) {
  smoke.finalInfo = info;
  assert.ok(info, `${smoke.name} final info should be available`);
  assert.equal(info.zeroCopyReceive, true);
  assert.equal(info.zcrxReady, true);
  assert.ok(info.zcrxPackets >= 1, `${smoke.name} should receive at least one ZCRX packet`);
  assert.ok(
    info.zcrxBytes >= minBytes,
    `${smoke.name} should account for at least ${minBytes} ZCRX bytes`
  );
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requestHttp(port, config) {
  return withTimeout(new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: config.connectHost,
        port,
        path: '/',
        agent: false,
        timeout: config.timeoutMs
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
  }), config.timeoutMs, 'HTTP ZCRX request');
}

function tcpRoundTrip(port, payload, config) {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.connectHost, port }, () => {
      socket.write(Buffer.from(payload));
    });
    let body = Buffer.alloc(0);
    socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error('TCP request timed out')));
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
      socket.end();
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  }), config.timeoutMs, 'TCP ZCRX round trip');
}

async function smokeHttp(report, config) {
  const server = new UringHttpServer({
    host: config.bindHost,
    port: 0,
    responseBody: 'zcrx http ok\n',
    bufferCount: 256,
    bufferSize: 4096,
    useZeroCopyReceive: true,
    zcrxInterfaceName: config.interfaceName,
    zcrxRxQueue: config.rxQueue,
    zcrxRxBufferSize: config.rxBufferSize
  });
  const info = server.start();
  assert.equal(info.zeroCopyReceive, true);
  assert.equal(info.zcrxReady, true);
  assert.ok(info.zcrxRxBufferSize >= 512);
  const smoke = {
    name: 'http',
    status: 'running',
    startInfo: info,
    finalInfo: null,
    response: null,
    error: null
  };
  report.smokes.push(smoke);
  try {
    const response = await requestHttp(info.port, config);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'zcrx http ok\n');
    smoke.response = response;
    assertZcrxTransportStats(smoke, server.info(), 1);
    smoke.status = 'passed';
  } catch (error) {
    smoke.status = 'failed';
    smoke.error = errorForReport(error);
    throw error;
  } finally {
    server.stop();
  }
}

async function smokeNativeEcho(report, config) {
  const server = new UringTcpEchoServer({
    host: config.bindHost,
    port: 0,
    bufferCount: 256,
    bufferSize: 4096,
    useZeroCopyReceive: true,
    zcrxInterfaceName: config.interfaceName,
    zcrxRxQueue: config.rxQueue,
    zcrxRxBufferSize: config.rxBufferSize
  });
  const info = server.start();
  assert.equal(info.zeroCopyReceive, true);
  assert.equal(info.zcrxReady, true);
  assert.ok(info.zcrxRxBufferSize >= 512);
  const smoke = {
    name: 'native-echo',
    status: 'running',
    startInfo: info,
    finalInfo: null,
    response: null,
    error: null
  };
  report.smokes.push(smoke);
  try {
    const response = await tcpRoundTrip(info.port, 'zcrx native echo', config);
    assert.equal(response, 'zcrx native echo');
    smoke.response = response;
    assertZcrxTransportStats(smoke, server.info(), Buffer.byteLength('zcrx native echo'));
    smoke.status = 'passed';
  } catch (error) {
    smoke.status = 'failed';
    smoke.error = errorForReport(error);
    throw error;
  } finally {
    server.stop();
  }
}

async function smokeProgrammableTcp(report, config) {
  const server = new UringTcpServer({
    host: config.bindHost,
    port: 0,
    bufferCount: 256,
    bufferSize: 4096,
    useZeroCopyReceive: true,
    zcrxInterfaceName: config.interfaceName,
    zcrxRxQueue: config.rxQueue,
    zcrxRxBufferSize: config.rxBufferSize
  });
  const info = server.start((event) => {
    if (event.eventType === 'data') {
      assert.equal(event.data.toString('utf8'), 'zcrx programmable');
      server.sendAndClose(event.connectionId, Buffer.from('zcrx programmable ok'));
    }
  });
  assert.equal(info.zeroCopyReceive, true);
  assert.equal(info.zcrxReady, true);
  assert.ok(info.zcrxRxBufferSize >= 512);
  const smoke = {
    name: 'programmable-tcp',
    status: 'running',
    startInfo: info,
    finalInfo: null,
    response: null,
    error: null
  };
  report.smokes.push(smoke);
  try {
    const response = await tcpRoundTrip(info.port, 'zcrx programmable', config);
    assert.equal(response, 'zcrx programmable ok');
    smoke.response = response;
    assertZcrxTransportStats(smoke, server.info(), Buffer.byteLength('zcrx programmable'));
    smoke.status = 'passed';
  } catch (error) {
    smoke.status = 'failed';
    smoke.error = errorForReport(error);
    throw error;
  } finally {
    server.stop();
  }
}

function runQueueStatsParserSelfTest() {
  const stats = parseEthtoolStats(`
NIC statistics:
     rx_queue_0_packets: 10
     rx_queue_0_bytes: 800
     rx_queue_0_drops: 1
     rx_queue_1_packets: 99
     tx_queue_0_packets: 44
     rxq0_pkts: 7
  `);
  assert.equal(stats.get('rx_queue_0_packets'), 10n);
  assert.equal(isSelectedRxQueueCounter('rx_queue_0_packets', 0), true);
  assert.equal(isSelectedRxQueueCounter('rx_queue_0_bytes', 0), true);
  assert.equal(isSelectedRxQueueCounter('rxq0_pkts', 0), true);
  assert.equal(isSelectedRxQueueCounter('rx_queue_0_drops', 0), false);
  assert.equal(isSelectedRxQueueCounter('rx_queue_1_packets', 0), false);
  assert.equal(isSelectedRxQueueCounter('tx_queue_0_packets', 0), false);
  const before = { counters: new Map([['rx_queue_0_packets', 10n], ['rx_queue_0_bytes', 800n]]) };
  const after = { counters: new Map([['rx_queue_0_packets', 12n], ['rx_queue_0_bytes', 936n]]) };
  const deltas = diffCounters(before, after);
  assert.deepEqual(deltas, [
    { name: 'rx_queue_0_packets', delta: 2n },
    { name: 'rx_queue_0_bytes', delta: 136n }
  ]);
  assert.deepEqual(countersForReport({ available: true, reason: null, counters: stats }).counters, {
    rx_queue_0_packets: '10',
    rx_queue_0_bytes: '800',
    rx_queue_0_drops: '1',
    rx_queue_1_packets: '99',
    tx_queue_0_packets: '44',
    rxq0_pkts: '7'
  });
  assert.deepEqual(deltasForReport(deltas), [
    { name: 'rx_queue_0_packets', delta: '2' },
    { name: 'rx_queue_0_bytes', delta: '136' }
  ]);
}

function writeReport(report, reportPath) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}

module.exports = {
  runQueueStatsParserSelfTest,
  runZcrxHardwareSmoke
};
