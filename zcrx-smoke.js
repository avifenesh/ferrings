'use strict';

const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
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

const UINT32_MAX = 0xffffffff;
const MAX_TIMEOUT_MS = 0x7fffffff;

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

    const routeBlocker = zcrxTrafficRouteBlocker(config);
    if (routeBlocker) {
      throw new Error(routeBlocker);
    }
    report.trafficRoute = await validateZcrxTrafficRoute(config);
    config.connectAddress = report.trafficRoute.resolvedAddress;
    report.config.connectAddress = config.connectAddress;

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
    if (error && error.trafficRoute) {
      report.trafficRoute = error.trafficRoute;
      config.connectAddress = error.trafficRoute.resolvedAddress;
      report.config.connectAddress = config.connectAddress;
    }
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
  const optionConnectHost = nonEmptyString(options.connectHost);
  const envConnectHost = nonEmptyString(process.env.ZCRX_CONNECT_HOST);
  const connectHost = optionConnectHost || envConnectHost || '127.0.0.1';
  const connectHostSource = optionConnectHost
    ? 'option'
    : envConnectHost
      ? 'env'
      : 'default';
  return {
    interfaceName: options.interfaceName || process.env.ZCRX_INTERFACE,
    rxQueue: integerOrDefault(
      'rxQueue',
      options.rxQueue,
      process.env.ZCRX_RX_QUEUE,
      0,
      0,
      UINT32_MAX
    ),
    rxBufferSize: integerOrDefault(
      'rxBufferSize',
      options.rxBufferSize,
      process.env.ZCRX_RX_BUFFER_SIZE,
      0,
      0,
      UINT32_MAX
    ),
    bindHost: options.bindHost || process.env.ZCRX_BIND_HOST || '0.0.0.0',
    connectHost,
    connectHostExplicit: connectHostSource !== 'default',
    connectHostSource,
    timeoutMs: integerOrDefault(
      'timeoutMs',
      options.timeoutMs,
      process.env.ZCRX_TIMEOUT_MS,
      5000,
      1,
      MAX_TIMEOUT_MS
    ),
    requireRxQueueStats:
      options.requireRxQueueStats !== undefined
        ? Boolean(options.requireRxQueueStats)
        : process.env.ZCRX_REQUIRE_RX_QUEUE_STATS === '1',
    reportPath: options.reportPath || process.env.ZCRX_REPORT_PATH,
    selfTest: Boolean(options.selfTest)
  };
}

function integerOrDefault(name, value, envValue, fallback, min, max) {
  const candidate = value !== undefined ? value : envValue;
  if (candidate === undefined || candidate === '') return fallback;
  const number = Number(candidate);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function nonEmptyString(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text.length > 0 ? text : '';
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
      connectAddress: config.connectAddress,
      connectHostExplicit: config.connectHostExplicit,
      connectHostSource: config.connectHostSource,
      timeoutMs: config.timeoutMs,
      requireRxQueueStats: config.requireRxQueueStats
    },
    warnings: [],
    trafficRoute: null,
    probe: null,
    queueCounters: null,
    smokes: []
  };
}

function zcrxTrafficRouteBlocker(config) {
  if (!config.connectHostExplicit) {
    return 'ZCRX_CONNECT_HOST is not set; pass --connect-host or set ZCRX_CONNECT_HOST to a host routed through the selected NIC path';
  }
  if (isLoopbackHost(config.connectHost)) {
    return `ZCRX_CONNECT_HOST=${config.connectHost} is loopback; use a host routed through the selected NIC path`;
  }
  if (isWildcardHost(config.connectHost)) {
    return `ZCRX_CONNECT_HOST=${config.connectHost} is a wildcard bind address; use a concrete host routed through the selected NIC path`;
  }
  return '';
}

async function validateZcrxTrafficRoute(config) {
  const resolved = await resolveConnectHostForRoute(config.connectHost);
  if (isLoopbackHost(resolved.address)) {
    throw new Error(
      `ZCRX_CONNECT_HOST=${config.connectHost} resolved to loopback ${resolved.address}; ` +
        'use a host routed through the selected NIC path'
    );
  }
  if (isWildcardHost(resolved.address)) {
    throw new Error(
      `ZCRX_CONNECT_HOST=${config.connectHost} resolved to wildcard ${resolved.address}; ` +
        'use a concrete host routed through the selected NIC path'
    );
  }

  const lookup = readIpRouteGet(resolved.address);
  const report = buildTrafficRouteReport(config, resolved, lookup);
  if (!report.matchesInterface) {
    throw routeValidationError(report.blocker, report);
  }
  return report;
}

function buildTrafficRouteReport(config, resolved, lookup) {
  const route = selectRouteWithDevice(lookup.routes);
  const routeDev = route && route.dev ? String(route.dev) : '';
  const report = {
    connectHost: config.connectHost,
    resolvedAddress: resolved.address,
    resolvedFamily: resolved.family,
    resolvedRecords: resolved.records,
    command: lookup.command,
    interfaceName: config.interfaceName,
    routeDev,
    matchesInterface: routeDev === config.interfaceName,
    route
  };
  if (!routeDev) {
    report.blocker =
      `could not determine route interface for ZCRX_CONNECT_HOST=${config.connectHost} ` +
      `(${resolved.address}); ip route get returned no dev field`;
    return report;
  }
  if (routeDev !== config.interfaceName) {
    report.blocker =
      `ZCRX_CONNECT_HOST=${config.connectHost} (${resolved.address}) routes via ${routeDev}, ` +
      `not selected ZCRX_INTERFACE=${config.interfaceName}`;
    return report;
  }

  return report;
}

function routeValidationError(message, trafficRoute) {
  const error = new Error(message);
  error.trafficRoute = trafficRoute;
  return error;
}

async function resolveConnectHostForRoute(host) {
  const normalized = normalizeHostForRoute(host);
  const ipFamily = net.isIP(normalized);
  if (ipFamily) {
    return {
      address: normalized,
      family: ipFamily,
      records: [{ address: normalized, family: ipFamily }]
    };
  }

  let records;
  try {
    records = await dns.lookup(normalized, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`could not resolve ZCRX_CONNECT_HOST=${host}: ${error.message}`);
  }
  if (!records || records.length === 0) {
    throw new Error(`could not resolve ZCRX_CONNECT_HOST=${host}: no addresses returned`);
  }
  const selected = records.find((record) => !isLoopbackHost(record.address) && !isWildcardHost(record.address)) || records[0];
  return {
    address: selected.address,
    family: selected.family,
    records: records.map((record) => ({ address: record.address, family: record.family }))
  };
}

function readIpRouteGet(address) {
  const args = ['-json', 'route', 'get', address];
  const output = spawnSync('ip', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  const command = ['ip', ...args];
  if (output.error || output.status !== 0) {
    const detail = output.error ? output.error.message : (output.stderr || output.stdout || 'ip route get failed').trim();
    throw new Error(`could not verify route for ${address}: ${command.join(' ')} failed: ${detail}`);
  }
  return {
    command,
    routes: parseIpRouteGetJson(output.stdout || '')
  };
}

function parseIpRouteGetJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`could not parse ip route get JSON output: ${error.message}`);
  }
  const routes = Array.isArray(parsed) ? parsed : [parsed];
  if (routes.length === 0 || routes.every((route) => !route || typeof route !== 'object')) {
    throw new Error('ip route get JSON output did not contain a route object');
  }
  return routes.filter((route) => route && typeof route === 'object');
}

function selectRouteWithDevice(routes) {
  return routes.find((route) => route.dev) || routes[0] || null;
}

function normalizeHostForRoute(host) {
  return String(host).trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

function isLoopbackHost(host) {
  const normalized = normalizeHostForRoute(host);
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){0,3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){0,3}$/.test(normalized)
  );
}

function isWildcardHost(host) {
  const normalized = normalizeHostForRoute(host);
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '0:0:0:0:0:0:0:0';
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
        host: connectHostForTraffic(config),
        port,
        path: '/',
        agent: false,
        headers: {
          host: config.connectHost
        },
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
    const socket = net.createConnection({ host: connectHostForTraffic(config), port }, () => {
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

function connectHostForTraffic(config) {
  return config.connectAddress || config.connectHost;
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
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('localhost.'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(isWildcardHost('0.0.0.0'), true);
  assert.equal(isWildcardHost('[::]'), true);
  assert.equal(isLoopbackHost('192.0.2.10'), false);
  assert.equal(isWildcardHost('192.0.2.10'), false);
  assert.deepEqual(parseIpRouteGetJson('[{"dst":"192.0.2.10","dev":"eth0","prefsrc":"192.0.2.1"}]'), [
    { dst: '192.0.2.10', dev: 'eth0', prefsrc: '192.0.2.1' }
  ]);
  assert.deepEqual(parseIpRouteGetJson('{"dst":"2001:db8::10","dev":"enp1s0"}'), [
    { dst: '2001:db8::10', dev: 'enp1s0' }
  ]);
  assert.equal(
    selectRouteWithDevice([
      { dst: '192.0.2.10' },
      { dst: '192.0.2.10', dev: 'eth1' }
    ]).dev,
    'eth1'
  );
  const routeReport = buildTrafficRouteReport(
    { connectHost: 'example.test', interfaceName: 'eth0' },
    {
      address: '192.0.2.10',
      family: 4,
      records: [{ address: '192.0.2.10', family: 4 }]
    },
    {
      command: ['ip', '-json', 'route', 'get', '192.0.2.10'],
      routes: [{ dst: '192.0.2.10', dev: 'eth0' }]
    }
  );
  assert.equal(routeReport.routeDev, 'eth0');
  assert.equal(routeReport.matchesInterface, true);
  const mismatchReport = buildTrafficRouteReport(
    { connectHost: 'example.test', interfaceName: 'eth0' },
    {
      address: '192.0.2.10',
      family: 4,
      records: [{ address: '192.0.2.10', family: 4 }]
    },
    {
      command: ['ip', '-json', 'route', 'get', '192.0.2.10'],
      routes: [{ dst: '192.0.2.10', dev: 'eth1' }]
    }
  );
  assert.equal(mismatchReport.routeDev, 'eth1');
  assert.equal(mismatchReport.matchesInterface, false);
  assert.match(mismatchReport.blocker, /routes via eth1, not selected ZCRX_INTERFACE=eth0/);
  const missingDevReport = buildTrafficRouteReport(
    { connectHost: 'example.test', interfaceName: 'eth0' },
    {
      address: '192.0.2.10',
      family: 4,
      records: [{ address: '192.0.2.10', family: 4 }]
    },
    {
      command: ['ip', '-json', 'route', 'get', '192.0.2.10'],
      routes: [{ dst: '192.0.2.10' }]
    }
  );
  assert.equal(missingDevReport.routeDev, '');
  assert.equal(missingDevReport.matchesInterface, false);
  assert.match(missingDevReport.blocker, /returned no dev field/);
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
