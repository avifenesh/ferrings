'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_DURATION_MS = '10000';
const DEFAULT_CONCURRENCY = '512';
const DEFAULT_QUEUE_DEPTH = '1024';
const REPORT_PATH = process.env.REPORT_PATH;

const env = {
  ...process.env,
  DURATION_MS: process.env.DURATION_MS || DEFAULT_DURATION_MS,
  CONCURRENCY: process.env.CONCURRENCY || DEFAULT_CONCURRENCY,
  QUEUE_DEPTH: process.env.QUEUE_DEPTH || DEFAULT_QUEUE_DEPTH
};

const report = {
  mode: 'high-concurrency',
  status: 'running',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  config: {
    durationMs: Number(env.DURATION_MS),
    concurrency: Number(env.CONCURRENCY),
    queueDepth: Number(env.QUEUE_DEPTH)
  },
  results: [],
  error: null
};

try {
  console.log({ mode: report.mode, ...report.config });
  report.results.push(run('HTTP fixed response', 'compare.js'));
  report.results.push(run('TCP echo matrix', 'tcp-echo.js'));
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

function run(label, script) {
  console.log(`\n== ${label} ==`);
  const childResult = {
    label,
    script,
    report: null
  };
  const childEnv = { ...env };
  const childReportPath = REPORT_PATH
    ? path.join(
        os.tmpdir(),
        `ferrings-high-${process.pid}-${path.basename(script, '.js')}-${Date.now()}.json`
      )
    : null;
  if (childReportPath) {
    childEnv.REPORT_PATH = childReportPath;
  }
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, script)],
    {
      cwd: path.join(__dirname, '..'),
      env: childEnv,
      stdio: 'inherit'
    }
  );
  if (result.error) {
    childResult.report = readChildReport(childReportPath);
    result.error.childResult = childResult;
    throw result.error;
  }
  childResult.report = readChildReport(childReportPath);
  if (result.status !== 0) {
    const error = new Error(`${script} exited with status ${result.status ?? 1}`);
    error.childResult = childResult;
    throw error;
  }
  return childResult;
}

function readChildReport(childReportPath) {
  if (!childReportPath) return null;
  if (!fs.existsSync(childReportPath)) return null;
  try {
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

function writeReport(output) {
  if (!REPORT_PATH) return;
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`high-concurrency benchmark report written: ${REPORT_PATH}`);
}

function errorForReport(error) {
  return {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
}
