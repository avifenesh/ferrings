'use strict';

const assert = require('node:assert/strict');
const {
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer,
  capabilities,
  zcrxProbe
} = require('../');

const caps = capabilities();
assert.equal(typeof caps.providedBufferRing, 'boolean');
assert.equal(typeof caps.providedBufferRingProbe, 'string');
assert.ok(caps.providedBufferRingProbe.length > 0);
if (caps.providedBufferRing) {
  assert.match(caps.providedBufferRingProbe, /provided-buffer ring.*succeeded/i);
} else {
  assert.match(caps.providedBufferRingProbe, /provided-buffer ring.*failed/i);
}
assert.equal(typeof caps.registeredSendBuffer, 'boolean');
assert.equal(typeof caps.registeredSendBufferProbe, 'string');
assert.ok(caps.registeredSendBufferProbe.length > 0);
if (caps.registeredSendBuffer) {
  assert.match(caps.registeredSendBufferProbe, /registered-buffer SEND.*succeeded/i);
} else {
  assert.match(caps.registeredSendBufferProbe, /registered-buffer SEND.*failed/i);
}
assert.equal(typeof caps.zcrxCqe32Ring, 'boolean');
assert.equal(typeof caps.zcrxCqe32RingProbe, 'string');
assert.ok(caps.zcrxCqe32RingProbe.length > 0);
const probe = zcrxProbe();
assert.equal(typeof probe.kernelOpcode, 'boolean');
assert.equal(probe.kernelOpcode, caps.zcrxKernelOpcode);
assert.equal(typeof probe.ready, 'boolean');
assert.equal(Array.isArray(probe.blockers), true);
assert.equal(Array.isArray(probe.kernelSecurityWarnings), true);
assert.equal(Array.isArray(caps.zcrxKernelSecurityWarnings), true);
assert.equal(typeof probe.rxQueue, 'number');
assert.equal(typeof probe.rxBufferSize, 'number');
assert.equal(probe.rxBufferSize, 0);
assert.equal(typeof probe.headerDataSplit, 'string');
assert.equal(typeof probe.flowSteering, 'string');
assert.equal(typeof probe.activeRegistration, 'boolean');
assert.equal(probe.activeRegistration, false);
assert.equal(typeof probe.note, 'string');
if (!probe.ready) {
  assert.ok(probe.blockers.length > 0);
}

const loopback = zcrxProbe({ interfaceName: 'lo' });
assert.equal(loopback.interfaceName, 'lo');
assert.equal(loopback.rxQueue, 0);
assert.equal(loopback.rxBufferSize, 0);
assert.equal(loopback.interfaceExists, true);
assert.equal(loopback.isLoopback, true);
assert.equal(loopback.ready, false);
assert.ok(loopback.blockers.some((blocker) => /loopback/i.test(blocker)));

const largeBufferProbe = zcrxProbe({ interfaceName: 'lo', rxBufferSize: 8192 });
assert.equal(largeBufferProbe.interfaceName, 'lo');
assert.equal(largeBufferProbe.rxBufferSize, 8192);
assert.equal(largeBufferProbe.activeRegistration, false);

const invalidBufferProbe = zcrxProbe({
  interfaceName: 'lo',
  rxBufferSize: 1,
  activeRegistration: true
});
assert.equal(invalidBufferProbe.ready, false);
assert.ok(invalidBufferProbe.blockers.some((blocker) => /rxBufferSize/i.test(blocker)));
assert.match(invalidBufferProbe.activeRegistrationResult, /rxBufferSize/i);

assert.throws(
  () => new UringHttpServer({ useZeroCopyReceive: true, zcrxRxBufferSize: 1 }),
  /zcrxRxBufferSize must be 0 or at least 512 bytes/i
);

const badQueue = zcrxProbe({ interfaceName: 'lo', rxQueue: loopback.rxQueueCount });
assert.equal(badQueue.interfaceName, 'lo');
assert.equal(badQueue.rxQueue, loopback.rxQueueCount);
assert.equal(badQueue.ready, false);
assert.ok(
  badQueue.blockers.some((blocker) => /RX queue .*outside discovered queue count/i.test(blocker))
);

const activeLoopback = zcrxProbe({ interfaceName: 'lo', activeRegistration: true });
assert.equal(activeLoopback.interfaceName, 'lo');
assert.equal(activeLoopback.activeRegistration, true);
assert.equal(activeLoopback.ready, false);
assert.equal(typeof activeLoopback.activeRegistrationResult, 'string');
if (activeLoopback.activeRegistrationErrno !== undefined) {
  assert.equal(typeof activeLoopback.activeRegistrationErrno, 'number');
}
assert.ok(activeLoopback.blockers.length > 0);

const server = new UringHttpServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopyReceive: true,
  zcrxInterfaceName: 'lo',
  zcrxRxQueue: 0
});

const zcrxStartupBlocker =
  /zero-copy receive requested.*(?:active ZCRX readiness probe.*register ZCRX ifq|known upstream ZCRX security advisory ranges)/i;

assert.throws(
  () => server.start(),
  zcrxStartupBlocker,
  'HTTP ZCRX startup should fail before use when readiness or kernel security blocks ZCRX'
);

server.stop();

const tcpServer = new UringTcpServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopyReceive: true,
  zcrxInterfaceName: 'lo',
  zcrxRxQueue: 0
});

assert.throws(
  () => tcpServer.start(() => {}),
  zcrxStartupBlocker,
  'programmable TCP ZCRX startup should fail before use when readiness or kernel security blocks ZCRX'
);

tcpServer.stop();

const echoServer = new UringTcpEchoServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopyReceive: true,
  zcrxInterfaceName: 'lo',
  zcrxRxQueue: 0
});

assert.throws(
  () => echoServer.start(),
  zcrxStartupBlocker,
  'native TCP echo ZCRX startup should fail before use when readiness or kernel security blocks ZCRX'
);

echoServer.stop();
console.log('zcrx gate ok');
