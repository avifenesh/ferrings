'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'check-registry-install.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-registry-install-state-'));
const preload = path.join(tmpDir, 'mock-spawn.js');

fs.writeFileSync(
  preload,
  `
    'use strict';

    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const originalSpawnSync = childProcess.spawnSync;
    const rootPackage = require(path.resolve(process.cwd(), 'package.json'));
    const target = detectNativeTarget();
    let installAttempts = 0;

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'npm') {
        return npm(commandArgs, options);
      }
      if (command === process.execPath) {
        return node(commandArgs, options);
      }
      return originalSpawnSync(command, args, options);
    };

    function npm(args, options) {
      if (args[0] === 'install') {
        installAttempts += 1;
        const failAttempts = Number(process.env.FERRINGS_TEST_FAIL_INSTALL_ATTEMPTS || '0');
        if (installAttempts <= failAttempts) {
          return done(1, '', 'simulated npm registry propagation miss\\n');
        }
        createFakeInstall(options.cwd);
        return done(0, 'added ferrings packages\\n');
      }
      return originalSpawnSync('npm', args, options);
    }

    function node(args, options) {
      const first = args[0] || '';
      if (first === '-e' || first === '--input-type=module') {
        return done(0, '');
      }
      if (first.endsWith(path.join('node_modules', '.bin', 'ferrings'))) {
        return ferringsCli(args.slice(1), options.cwd);
      }
      return originalSpawnSync(process.execPath, args, options);
    }

    function ferringsCli(args, cwd) {
      if (args.includes('--version')) {
        return done(0, rootPackage.name + ' ' + rootPackage.version + '\\n');
      }
      const command = args[0];
      if (command === 'capabilities') {
        return done(0, JSON.stringify({
          package: rootPackage.name,
          version: rootPackage.version,
          mode: 'capabilities',
          capabilities: { ioUringAvailable: true }
        }) + '\\n');
      }
      if (command === 'doctor') {
        const nativeExists = fs.existsSync(
          path.join(cwd, 'node_modules', target.packageName, target.nativeFile)
        );
        if (!nativeExists) {
          const report = {
            package: rootPackage.name,
            version: rootPackage.version,
            mode: 'doctor',
            ready: false,
            defaultReady: false,
            verdict: 'native-load-blocked',
            nativeLoadError: { code: 'FERRINGS_NATIVE_LOAD_FAILED' }
          };
          return done(args.includes('--require-ready') ? 2 : 0, JSON.stringify(report) + '\\n');
        }
        return done(0, JSON.stringify({
          package: rootPackage.name,
          version: rootPackage.version,
          mode: 'doctor',
          zcrx: {
            interfaceName: 'lo',
            ready: false
          },
          transport: { ready: true },
          zcrxRequired: false,
          defaultReady: true,
          ready: true,
          blockers: [],
          optionalBlockers: ['loopback interface cannot validate ZCRX'],
          nextCommand: 'default transport is ready'
        }) + '\\n');
      }
      if (command === 'zcrx-probe') {
        return done(0, JSON.stringify({
          package: rootPackage.name,
          version: rootPackage.version,
          mode: 'zcrx-probe',
          probe: { interfaceName: 'lo' }
        }) + '\\n');
      }
      if (command === 'zcrx-smoke') {
        return done(0, JSON.stringify({
          status: 'skipped',
          skippedReason: 'set ZCRX_INTERFACE or pass --interface before running this hardware test'
        }) + '\\n');
      }
      return done(64, '', 'unknown command\\n');
    }

    function createFakeInstall(appDir) {
      const rootDir = path.join(appDir, 'node_modules', rootPackage.name);
      const nativeDir = path.join(appDir, 'node_modules', target.packageName);
      fs.mkdirSync(rootDir, { recursive: true });
      fs.mkdirSync(nativeDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({
        name: rootPackage.name,
        version: rootPackage.version,
        optionalDependencies: {
          [target.packageName]: rootPackage.version
        }
      }));
      fs.writeFileSync(path.join(nativeDir, 'package.json'), JSON.stringify({
        name: target.packageName,
        version: rootPackage.version,
        os: ['linux'],
        cpu: [target.cpu],
        libc: [target.libc]
      }));
      fs.writeFileSync(path.join(nativeDir, target.nativeFile), '');
    }

    function detectNativeTarget() {
      const arch = process.arch;
      const libc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
      const platform = 'linux-' + arch + '-' + libc;
      return {
        packageName: 'ferrings-' + platform,
        nativeFile: 'ferrings.' + platform + '.node',
        cpu: arch,
        libc: libc === 'gnu' ? 'glibc' : 'musl'
      };
    }

    function done(status, stdout = '', stderr = '') {
      return {
        pid: 1,
        output: [null, stdout, stderr],
        stdout,
        stderr,
        status,
        signal: null,
        error: undefined
      };
    }
  `
);

try {
  const noRetry = runScenario({ retries: 1, failInstallAttempts: 1 });
  assert.equal(noRetry.statusCode, 1);
  assert.equal(noRetry.report.status, 'failed');
  assert.equal(noRetry.report.attempt, 1);
  assert.equal(noRetry.report.previousErrors.length, 0);
  assert.match(noRetry.report.error.message, /simulated npm registry propagation miss/);

  const retrySuccess = runScenario({ retries: 2, failInstallAttempts: 1 });
  assert.equal(retrySuccess.statusCode, 0);
  assert.equal(retrySuccess.report.status, 'passed');
  assert.equal(retrySuccess.report.attempt, 2);
  assert.equal(retrySuccess.report.previousErrors.length, 1);
  assert.equal(retrySuccess.report.previousErrors[0].attempt, 1);
  assert.match(
    retrySuccess.report.previousErrors[0].error.message,
    /simulated npm registry propagation miss/
  );

  const firstAttemptSuccess = runScenario({ retries: 3, failInstallAttempts: 0 });
  assert.equal(firstAttemptSuccess.statusCode, 0);
  assert.equal(firstAttemptSuccess.report.status, 'passed');
  assert.equal(firstAttemptSuccess.report.attempt, 1);
  assert.equal(firstAttemptSuccess.report.previousErrors.length, 0);

  console.log('registry install state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runScenario({ retries, failInstallAttempts }) {
  const result = spawnSync(
    process.execPath,
    [
      '--require',
      preload,
      script,
      '--version',
      rootPackage.version,
      '--retries',
      String(retries),
      '--retry-delay-ms',
      '0',
      '--json'
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FERRINGS_TEST_FAIL_INSTALL_ATTEMPTS: String(failInstallAttempts)
      }
    }
  );
  if (result.error) throw result.error;
  return {
    statusCode: result.status,
    report: JSON.parse(result.stdout)
  };
}
