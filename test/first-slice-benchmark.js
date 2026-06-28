'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const reportPath = path.join(
  os.tmpdir(),
  `ferrings-first-slice-test-${process.pid}.json`
);

try {
  const result = spawnSync(process.execPath, ['benchmark/first-slice.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      DURATION_MS: '50',
      CONCURRENCY: '2',
      QUEUE_DEPTH: '32',
      BUFFER_COUNT: '64',
      BUFFER_SIZE: '2048',
      TCP_CASES: 'node:net echo,ferrings native tcp echo,ferrings tcp facade echo',
      SYSCALL_REQUESTS: '8',
      SYSCALL_CONCURRENCY: '2',
      SYSCALL_CASES: 'node-http,ferrings-http,node-tcp,ferrings-native-tcp',
      REPORT_PATH: reportPath
    }
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `first-slice benchmark failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.equal(fs.existsSync(reportPath), true);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.mode, 'first-slice');
  assert.equal(report.status, 'passed');
  assert.equal(typeof report.capabilities.ioUringAvailable, 'boolean');
  assert.equal(report.results.length, 3);

  const http = report.results.find((entry) => entry.script === 'compare.js');
  assert.equal(http.status, 'passed');
  assert.equal(http.report.mode, 'http-fixed-response');
  assert.ok(http.report.results.some((entry) => entry.caseName === 'node:http'));
  assert.ok(http.report.results.some((entry) => entry.caseName === 'ferrings'));
  const ferringsHttp = http.report.results.find((entry) => entry.caseName === 'ferrings');
  assert.equal(ferringsHttp.result.serverInfo.recvCopyBytes, 0);
  assert.equal(typeof ferringsHttp.result.serverInfo.fixedSendBufferMisses, 'number');

  const tcp = report.results.find((entry) => entry.script === 'tcp-echo.js');
  assert.equal(tcp.status, 'passed');
  assert.equal(tcp.report.mode, 'tcp-echo-matrix');
  assert.ok(tcp.report.results.some((entry) => entry.caseName === 'node:net echo'));
  assert.ok(tcp.report.results.some((entry) => entry.caseName === 'ferrings native tcp echo'));
  assert.ok(tcp.report.results.some((entry) => entry.caseName === 'ferrings tcp facade echo'));
  const ferringsNativeTcp = tcp.report.results.find(
    (entry) => entry.caseName === 'ferrings native tcp echo'
  );
  assert.ok(ferringsNativeTcp.result.serverInfo.recvCopyBytes > 0);
  assert.equal(typeof ferringsNativeTcp.result.serverInfo.fixedSendBufferMisses, 'number');
  const ferringsFacadeTcp = tcp.report.results.find(
    (entry) => entry.caseName === 'ferrings tcp facade echo'
  );
  assert.ok(ferringsFacadeTcp.result.serverInfo.recvCopyBytes > 0);
  assert.equal(typeof ferringsFacadeTcp.result.serverInfo.fixedSendBufferMisses, 'number');

  const syscalls = report.results.find((entry) => entry.script === 'syscalls.js');
  assert.ok(['passed', 'skipped'].includes(syscalls.status));
  if (syscalls.status === 'passed') {
    assert.equal(syscalls.report.mode, 'syscalls');
    assert.ok(syscalls.report.results.some((entry) => entry.caseName === 'node-http'));
    assert.ok(syscalls.report.results.some((entry) => entry.caseName === 'ferrings-http'));
  }

  assert.equal(report.summary.httpLatency.metric, 'p99Ms');
  assert.equal(report.summary.tcpNativeLatency.metric, 'p99Ms');
  assert.equal(report.summary.tcpFacadeLatency.metric, 'p99Ms');
  assert.equal(report.summary.tcpFacadeBatchLatency, null);
  console.log('first-slice benchmark smoke ok');
} finally {
  fs.rmSync(reportPath, { force: true });
}
