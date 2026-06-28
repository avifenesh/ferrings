'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { capabilities } = require('../');

const DURATION_MS = String(process.env.DURATION_MS || 1000);
const CONCURRENCY = String(process.env.CONCURRENCY || 128);
const QUEUE_DEPTH = String(process.env.QUEUE_DEPTH || 256);
const SYSCALL_REQUESTS = String(process.env.SYSCALL_REQUESTS || 200);
const SYSCALL_CONCURRENCY = String(process.env.SYSCALL_CONCURRENCY || 32);
const SYSCALL_CASES =
  process.env.SYSCALL_CASES ||
  'node-http,ferrings-http,node-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch,ferrings-native-tcp';
const REPORT_PATH = process.env.REPORT_PATH;

const report = {
  mode: 'first-slice',
  status: 'running',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  config: {
    durationMs: Number(DURATION_MS),
    concurrency: Number(CONCURRENCY),
    queueDepth: Number(QUEUE_DEPTH),
    syscallRequests: Number(SYSCALL_REQUESTS),
    syscallConcurrency: Number(SYSCALL_CONCURRENCY),
    syscallCases: SYSCALL_CASES.split(',').map((name) => name.trim()).filter(Boolean)
  },
  capabilities: capabilities(),
  results: [],
  summary: {},
  error: null
};

try {
  console.log({ mode: report.mode, ...report.config });
  report.results.push(
    runBenchmark('HTTP fixed response latency', 'compare.js', {
      DURATION_MS,
      CONCURRENCY,
      QUEUE_DEPTH
    })
  );
  report.results.push(
    runBenchmark('TCP echo latency matrix', 'tcp-echo.js', {
      DURATION_MS,
      CONCURRENCY,
      QUEUE_DEPTH
    })
  );
  report.results.push(runSyscallBenchmark());
  report.summary = buildSummary(report);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = errorForReport(error);
  if (error && error.childResult) {
    report.results.push(error.childResult);
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  writeReport(report);
}

function runSyscallBenchmark() {
  const strace = spawnSync('strace', ['-V'], { encoding: 'utf8' });
  if (strace.error || strace.status !== 0) {
    return {
      label: 'Syscalls per connection',
      script: 'syscalls.js',
      status: 'skipped',
      skippedReason: 'strace is not available',
      report: null
    };
  }
  return runBenchmark('Syscalls per connection', 'syscalls.js', {
    REQUESTS: SYSCALL_REQUESTS,
    CONCURRENCY: SYSCALL_CONCURRENCY,
    QUEUE_DEPTH,
    CASES: SYSCALL_CASES
  });
}

function runBenchmark(label, script, extraEnv) {
  console.log(`\n== ${label} ==`);
  const childReportPath = path.join(
    os.tmpdir(),
    `ferrings-first-slice-${process.pid}-${path.basename(script, '.js')}-${Date.now()}.json`
  );
  const childResult = {
    label,
    script,
    status: 'running',
    report: null
  };
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...extraEnv,
      REPORT_PATH: childReportPath
    },
    stdio: 'inherit'
  });
  childResult.report = readChildReport(childReportPath);
  childResult.status = result.status === 0 ? 'passed' : 'failed';
  if (result.error) {
    result.error.childResult = childResult;
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`${script} exited with status ${result.status ?? 1}`);
    error.childResult = childResult;
    throw error;
  }
  return childResult;
}

function readChildReport(childReportPath) {
  try {
    if (!fs.existsSync(childReportPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(childReportPath, 'utf8'));
  } catch (error) {
    return {
      status: 'unreadable',
      error: errorForReport(error)
    };
  } finally {
    fs.rmSync(childReportPath, { force: true });
  }
}

function buildSummary(output) {
  const httpReport = childReport(output, 'compare.js');
  const tcpReport = childReport(output, 'tcp-echo.js');
  const syscallsReport = childReport(output, 'syscalls.js');
  return {
    httpLatency: compareResults(
      resultByCase(httpReport, 'node:http'),
      resultByCase(httpReport, 'ferrings')
    ),
    tcpNativeLatency: compareResults(
      resultByCase(tcpReport, 'node:net echo'),
      resultByCase(tcpReport, 'ferrings native tcp echo')
    ),
    tcpFacadeLatency: compareResults(
      resultByCase(tcpReport, 'node:net echo'),
      resultByCase(tcpReport, 'ferrings tcp facade echo')
    ),
    tcpFacadeBatchLatency: compareResults(
      resultByCase(tcpReport, 'node:net echo'),
      resultByCase(tcpReport, 'ferrings tcp facade batch echo')
    ),
    httpSyscalls: compareResults(
      resultByCase(syscallsReport, 'node-http'),
      resultByCase(syscallsReport, 'ferrings-http'),
      'syscallsPerConnection'
    ),
    tcpNativeSyscalls: compareResults(
      resultByCase(syscallsReport, 'node-tcp'),
      resultByCase(syscallsReport, 'ferrings-native-tcp'),
      'syscallsPerConnection'
    ),
    tcpFacadeSyscalls: compareResults(
      resultByCase(syscallsReport, 'node-tcp'),
      resultByCase(syscallsReport, 'ferrings-tcp-facade'),
      'syscallsPerConnection'
    ),
    tcpFacadeBatchSyscalls: compareResults(
      resultByCase(syscallsReport, 'node-tcp'),
      resultByCase(syscallsReport, 'ferrings-tcp-facade-batch'),
      'syscallsPerConnection'
    )
  };
}

function childReport(output, script) {
  const entry = output.results.find((result) => result.script === script);
  return entry && entry.report && entry.report.status === 'passed' ? entry.report : null;
}

function resultByCase(child, caseName) {
  if (!child || !Array.isArray(child.results)) return null;
  const entry = child.results.find((result) => result.caseName === caseName);
  return entry ? entry.result : null;
}

function compareResults(baseline, candidate, metric = 'p99Ms') {
  if (!baseline || !candidate) {
    return null;
  }
  const baselineMetric = Number(baseline[metric]);
  const candidateMetric = Number(candidate[metric]);
  return {
    baseline,
    candidate,
    metric,
    baselineValue: baselineMetric,
    candidateValue: candidateMetric,
    delta: finiteNumber(candidateMetric - baselineMetric),
    ratio: finiteNumber(candidateMetric / baselineMetric),
    rpsRatio: finiteNumber(Number(candidate.rps) / Number(baseline.rps))
  };
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function writeReport(output) {
  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`first-slice benchmark report written: ${REPORT_PATH}`);
  } else {
    console.log(JSON.stringify(output.summary, null, 2));
  }
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}
