'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const pkg = require('../package.json');

const cli = path.resolve(__dirname, '..', 'bin', 'ferrings.js');

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expectedStatus,
    `expected status ${expectedStatus} for ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

const caps = JSON.parse(run(['capabilities', '--json']).stdout);
assert.equal(caps.package, 'ferrings');
assert.equal(caps.mode, 'capabilities');
assert.equal(typeof caps.capabilities.ioUringAvailable, 'boolean');
assert.equal(typeof caps.capabilities.recvZc, 'boolean');

const doctor = JSON.parse(run(['doctor', '--json']).stdout);
assert.equal(doctor.package, 'ferrings');
assert.equal(doctor.mode, 'doctor');
assert.equal(typeof doctor.ready, 'boolean');
assert.equal(typeof doctor.transport.ready, 'boolean');
assert.equal(typeof doctor.zcrx.ready, 'boolean');
assert.equal(typeof doctor.nextCommand, 'string');

const doctorLoopback = JSON.parse(run(['doctor', '-i', 'lo', '--json']).stdout);
assert.equal(doctorLoopback.zcrx.interfaceName, 'lo');
assert.equal(doctorLoopback.ready, false);
assert.ok(doctorLoopback.blockers.some((blocker) => /loopback/i.test(blocker)));

const loopback = JSON.parse(run(['zcrx-probe', '--interface', 'lo', '--json']).stdout);
assert.equal(loopback.package, 'ferrings');
assert.equal(loopback.mode, 'zcrx-probe');
assert.equal(loopback.probe.interfaceName, 'lo');
assert.equal(loopback.probe.ready, false);
assert.ok(loopback.probe.blockers.some((blocker) => /loopback/i.test(blocker)));

const loopbackShort = JSON.parse(run(['zcrx-probe', '-i', 'lo', '--json']).stdout);
assert.equal(loopbackShort.probe.interfaceName, 'lo');

const loopbackShortEquals = JSON.parse(run(['zcrx-probe', '-i=lo', '--json']).stdout);
assert.equal(loopbackShortEquals.probe.interfaceName, 'lo');

const all = JSON.parse(run(['zcrx-probe', '--all', '--compact']).stdout);
assert.equal(Array.isArray(all.probes), true);
assert.ok(all.probes.length >= 1);

const smokeSkipped = JSON.parse(run(['zcrx-smoke', '--json']).stdout);
assert.equal(smokeSkipped.status, 'skipped');
assert.match(smokeSkipped.skippedReason, /ZCRX_INTERFACE|--interface/);

const smokeMissingConnectHost = JSON.parse(
  run(['zcrx-smoke', '--interface', 'lo', '--json'], 1).stdout
);
assert.equal(smokeMissingConnectHost.status, 'failed');
assert.match(smokeMissingConnectHost.error.message, /ZCRX_CONNECT_HOST|--connect-host/);
assert.equal(smokeMissingConnectHost.config.connectHostExplicit, false);

const smokeLoopbackConnectHost = JSON.parse(
  run(['zcrx-smoke', '--interface', 'lo', '--connect-host', '127.0.0.1', '--json'], 1)
    .stdout
);
assert.equal(smokeLoopbackConnectHost.status, 'failed');
assert.match(smokeLoopbackConnectHost.error.message, /loopback/);

const smokeWildcardConnectHost = JSON.parse(
  run(['zcrx-smoke', '--interface', 'lo', '--connect-host', '0.0.0.0', '--json'], 1)
    .stdout
);
assert.equal(smokeWildcardConnectHost.status, 'failed');
assert.match(smokeWildcardConnectHost.error.message, /wildcard/);

const smokeSelfTest = run(['zcrx-smoke', '--self-test']);
assert.match(smokeSelfTest.stdout, /zcrx smoke self-test ok/);

const help = run(['-h']);
assert.match(help.stdout, /Usage:/);

for (const args of [['--version'], ['-v'], ['version']]) {
  const version = run(args);
  assert.equal(version.stdout.trim(), `${pkg.name} ${pkg.version}`);
}

const required = run(['zcrx-probe', '--interface', 'lo', '--require-ready', '--json'], 2);
const requiredReport = JSON.parse(required.stdout);
assert.equal(requiredReport.ready, false);
assert.match(required.stderr, /ZCRX readiness requirements were not met/);

const doctorRequired = run(['doctor', '-i', 'lo', '--require-ready', '--json'], 2);
const doctorRequiredReport = JSON.parse(doctorRequired.stdout);
assert.equal(doctorRequiredReport.ready, false);
assert.match(doctorRequired.stderr, /doctor readiness requirements were not met/);

console.log('cli smoke ok');
