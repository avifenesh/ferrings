'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackageJson = require(path.join(repoRoot, 'package.json'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-package-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result;
}

function temporarilyRemove(filePaths, callback) {
  const moved = [];
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    const backupPath = `${filePath}.ferrings-smoke-backup-${process.pid}`;
    fs.renameSync(filePath, backupPath);
    moved.push({ filePath, backupPath });
  }

  try {
    callback();
  } finally {
    for (const { filePath, backupPath } of moved.reverse()) {
      if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, filePath);
      }
    }
  }
}

try {
  const packDir = path.join(tmpRoot, 'pack');
  const appDir = path.join(tmpRoot, 'app');
  const nativePackageDir = path.join(tmpRoot, 'native-package');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(nativePackageDir, { recursive: true });

  const pack = run('npm', ['pack', '--pack-destination', packDir, '--json']);
  const [packed] = JSON.parse(pack.stdout);
  assert.ok(packed, 'npm pack should report one package');
  const packedFiles = new Set(packed.files.map((file) => file.path));
  assert.equal(packedFiles.has('README.md'), true);
  assert.equal(packedFiles.has('CHANGELOG.md'), true);
  assert.equal(packedFiles.has('CONTRIBUTING.md'), true);
  assert.equal(packedFiles.has('CODE_OF_CONDUCT.md'), true);
  assert.equal(packedFiles.has('SECURITY.md'), true);
  assert.equal(packedFiles.has('docs/production.md'), true);
  assert.equal(packedFiles.has('ferrings.linux-x64-gnu.node'), false);
  assert.equal(packedFiles.has('LICENSE-APACHE'), true);
  assert.equal(packedFiles.has('LICENSE-MIT'), true);
  assert.equal(packedFiles.has('index.js'), true);
  assert.equal(packedFiles.has('index.d.ts'), true);
  assert.equal(packedFiles.has('native.js'), true);
  assert.equal(packedFiles.has('native.d.ts'), true);
  assert.equal(packedFiles.has('tcp-transport.js'), true);
  assert.equal(packedFiles.has('zcrx-smoke.js'), true);
  assert.equal(packedFiles.has('bin/ferrings.js'), true);
  assert.equal(packedFiles.has('benchmark/quick-benchmark.js'), true);
  assert.equal(packedFiles.has('src/uring.rs'), false);
  assert.equal(packedFiles.has('test/smoke.js'), false);

  const tarball = path.join(packDir, packed.filename);
  const nativeTarball = packNativePackage(packDir, nativePackageDir);
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball, nativeTarball],
    { cwd: appDir }
  );

  const installedPackageDir = path.join(appDir, 'node_modules', 'ferrings');
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(installedPackageDir, 'package.json'), 'utf8')
  );
  assert.equal(installedPackageJson.private, undefined);
  assert.equal(installedPackageJson.license, 'MIT OR Apache-2.0');
  assert.deepEqual(installedPackageJson.os, ['linux']);
  assert.deepEqual(installedPackageJson.cpu, rootPackageJson.cpu);
  assert.deepEqual(installedPackageJson.libc, rootPackageJson.libc);
  assert.deepEqual(installedPackageJson.napi.targets, [
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    'x86_64-unknown-linux-musl',
    'aarch64-unknown-linux-musl'
  ]);
  assert.deepEqual(installedPackageJson.optionalDependencies, rootPackageJson.optionalDependencies);
  assert.equal(fs.existsSync(path.join(installedPackageDir, 'native.js')), true);
  assert.equal(fs.existsSync(path.join(installedPackageDir, 'native.d.ts')), true);
  assert.equal(fs.existsSync(path.join(installedPackageDir, 'docs', 'production.md')), true);
  assert.equal(fs.existsSync(path.join(installedPackageDir, 'ferrings.linux-x64-gnu.node')), false);
  assert.equal(
    fs.existsSync(
      path.join(
        appDir,
        'node_modules',
        'ferrings-linux-x64-gnu',
        'ferrings.linux-x64-gnu.node'
      )
    ),
    true
  );
  assert.match(
    fs.readFileSync(path.join(installedPackageDir, 'native.js'), 'utf8'),
    /require\('\.\/ferrings\.linux-x64-gnu\.node'\)/
  );

  temporarilyRemove(
    [
      path.join(
        appDir,
        'node_modules',
        'ferrings-linux-x64-gnu',
        'ferrings.linux-x64-gnu.node'
      )
    ],
    () => {
      const diagnosticScript = `
        const assert = require('node:assert/strict');
        try {
          require('ferrings');
          assert.fail('requiring ferrings should fail without embedded or optional native bindings');
        } catch (error) {
          assert.equal(error.name, 'FerringsNativeLoadError');
          assert.equal(error.code, 'FERRINGS_NATIVE_LOAD_FAILED');
          assert.equal(error.target.platform, process.platform);
          assert.equal(error.target.arch, process.arch);
          assert.equal(Array.isArray(error.nativePackages), true);
          assert.match(error.message, /ferrings could not load its native Linux binding/);
          assert.match(error.message, /ferrings-linux-x64-gnu/);
          assert.match(error.message, /optional dependencies enabled/);
          assert.match(error.message, /Original loader error:/);
          assert.ok(error.cause);
        }
      `;
      run(process.execPath, ['-e', diagnosticScript], {
        cwd: appDir
      });
    }
  );

  const smokeScript = `
    const assert = require('node:assert/strict');
    const net = require('node:net');
    const ferrings = require('ferrings');
    assert.equal(typeof ferrings.UringTcpServer, 'function');
    assert.equal(typeof ferrings.createTcpServer, 'function');
    assert.equal(typeof ferrings.capabilities, 'function');
    const server = ferrings.createTcpServer((connection) => {
      assert.equal(connection.remoteAddress, '127.0.0.1');
      assert.equal(connection.remoteFamily, 'IPv4');
      assert.equal(typeof connection.remotePort, 'number');
      assert.ok(connection.remotePort > 0);
      connection.on('data', (data) => {
        connection.end('tarball:' + data.toString('utf8'));
      });
    });
    assert.equal(typeof server.sendBatch, 'function');
    assert.equal(typeof server.sendBatchAndClose, 'function');
    assert.equal(typeof server.getConnections, 'function');
    const info = server.listen(0, '127.0.0.1').info();
    server.getConnections((error, count) => {
      assert.ifError(error);
      assert.equal(count, 0);
    });
    assert.equal(info.backend, 'io_uring');
    assert.equal(info.tcpNoDelay, true);
    assert.equal(info.reusePort, false);
    assert.equal(info.tcpDeferAcceptSeconds, 0);
    assert.equal(info.socketRecvBufferSize, 0);
    assert.equal(info.socketSendBufferSize, 0);
    assert.equal(info.eventBatchSize, 64);
    assert.equal(info.sendBufferCount, 256);
    assert.equal(info.sendBufferSize, 2048);
    const socket = net.createConnection({ host: '127.0.0.1', port: info.port }, () => {
      socket.write('ok');
    });
    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      try {
        assert.equal(body.toString('utf8'), 'tarball:ok');
        server.close();
      } catch (error) {
        server.close();
        throw error;
      }
    });
    socket.on('error', (error) => {
      server.close();
      throw error;
    });
  `;
  run(process.execPath, ['-e', smokeScript], {
    cwd: appDir
  });

  const binPath = path.join(appDir, 'node_modules', '.bin', 'ferrings');
  const cliCaps = run(binPath, ['capabilities', '--json'], {
    cwd: appDir
  });
  const cliCapsReport = JSON.parse(cliCaps.stdout);
  assert.equal(cliCapsReport.package, 'ferrings');
  assert.equal(cliCapsReport.mode, 'capabilities');
  assert.equal(typeof cliCapsReport.capabilities.ioUringAvailable, 'boolean');

  const cliDoctor = run(binPath, ['doctor', '--interface', 'lo', '--json'], {
    cwd: appDir
  });
  const cliDoctorReport = JSON.parse(cliDoctor.stdout);
  assert.equal(cliDoctorReport.package, 'ferrings');
  assert.equal(cliDoctorReport.mode, 'doctor');
  assert.equal(cliDoctorReport.zcrx.interfaceName, 'lo');
  assert.equal(typeof cliDoctorReport.transport.ready, 'boolean');
  assert.equal(typeof cliDoctorReport.nextCommand, 'string');

  const cliProbe = run(binPath, ['zcrx-probe', '--interface', 'lo', '--json'], {
    cwd: appDir
  });
  const cliProbeReport = JSON.parse(cliProbe.stdout);
  assert.equal(cliProbeReport.package, 'ferrings');
  assert.equal(cliProbeReport.mode, 'zcrx-probe');
  assert.equal(cliProbeReport.probe.interfaceName, 'lo');

  const cliProbeShort = run(binPath, ['zcrx-probe', '-i', 'lo', '--json'], {
    cwd: appDir
  });
  const cliProbeShortReport = JSON.parse(cliProbeShort.stdout);
  assert.equal(cliProbeShortReport.probe.interfaceName, 'lo');

  const cliSmoke = run(binPath, ['zcrx-smoke', '--json'], {
    cwd: appDir
  });
  const cliSmokeReport = JSON.parse(cliSmoke.stdout);
  assert.equal(cliSmokeReport.status, 'skipped');
  assert.match(cliSmokeReport.skippedReason, /ZCRX_INTERFACE|--interface/);

  const installedBenchmarkReportPath = path.join(tmpRoot, 'installed-quick-benchmark.json');
  run(process.execPath, [path.join(installedPackageDir, 'benchmark', 'quick-benchmark.js')], {
    cwd: appDir,
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
      REPORT_PATH: installedBenchmarkReportPath
    }
  });
  const installedBenchmarkReport = JSON.parse(
    fs.readFileSync(installedBenchmarkReportPath, 'utf8')
  );
  assert.equal(installedBenchmarkReport.mode, 'quick-benchmark');
  assert.equal(installedBenchmarkReport.status, 'passed');
  assert.equal(typeof installedBenchmarkReport.capabilities.ioUringAvailable, 'boolean');
  assert.equal(installedBenchmarkReport.results.length, 3);

  const installedHttp = installedBenchmarkReport.results.find(
    (entry) => entry.script === 'compare.js'
  );
  assert.equal(installedHttp.status, 'passed');
  assert.equal(installedHttp.report.mode, 'http-fixed-response');
  const installedFerringsHttp = installedHttp.report.results.find(
    (entry) => entry.caseName === 'ferrings'
  );
  assert.equal(installedFerringsHttp.result.serverInfo.recvCopyBytes, 0);
  assert.equal(typeof installedFerringsHttp.result.serverInfo.fixedSendBufferMisses, 'number');

  const installedTcp = installedBenchmarkReport.results.find(
    (entry) => entry.script === 'tcp-echo.js'
  );
  assert.equal(installedTcp.status, 'passed');
  assert.equal(installedTcp.report.mode, 'tcp-echo-matrix');
  const installedFerringsNativeTcp = installedTcp.report.results.find(
    (entry) => entry.caseName === 'ferrings native tcp echo'
  );
  assert.ok(installedFerringsNativeTcp.result.serverInfo.recvCopyBytes > 0);
  assert.equal(
    typeof installedFerringsNativeTcp.result.serverInfo.fixedSendBufferMisses,
    'number'
  );
  const installedFerringsFacadeTcp = installedTcp.report.results.find(
    (entry) => entry.caseName === 'ferrings tcp facade echo'
  );
  assert.ok(installedFerringsFacadeTcp.result.serverInfo.recvCopyBytes > 0);
  assert.equal(
    typeof installedFerringsFacadeTcp.result.serverInfo.fixedSendBufferMisses,
    'number'
  );
  const installedSyscalls = installedBenchmarkReport.results.find(
    (entry) => entry.script === 'syscalls.js'
  );
  assert.ok(['passed', 'skipped'].includes(installedSyscalls.status));

  console.log('package install smoke ok');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function packNativePackage(packDir, nativePackageDir) {
  for (const fileName of [
    'package.json',
    'ferrings.linux-x64-gnu.node',
    'LICENSE-APACHE',
    'LICENSE-MIT'
  ]) {
    const source =
      fileName === 'package.json'
        ? path.join(repoRoot, 'npm', 'linux-x64-gnu', fileName)
        : path.join(repoRoot, fileName);
    assert.equal(fs.existsSync(source), true, `${source} is missing`);
    fs.copyFileSync(source, path.join(nativePackageDir, fileName));
  }

  const pack = run('npm', ['pack', nativePackageDir, '--pack-destination', packDir, '--json']);
  const [packed] = JSON.parse(pack.stdout);
  assert.equal(packed.name, 'ferrings-linux-x64-gnu');
  const packedFiles = new Set(packed.files.map((file) => file.path));
  assert.equal(packedFiles.has('ferrings.linux-x64-gnu.node'), true);
  assert.equal(packedFiles.has('LICENSE-APACHE'), true);
  assert.equal(packedFiles.has('LICENSE-MIT'), true);
  return path.join(packDir, packed.filename);
}
