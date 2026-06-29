'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeSupport } = require('./node-runtime');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const version = valueAfter('--version') || rootPackage.version;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-registry-install-'));
const appDir = path.join(tmpRoot, 'app');
const target = detectNativeTarget();
const report = {
  package: rootPackage.name,
  version,
  target,
  node: {
    version: process.versions.node,
    engine: rootPackage.engines?.node || null
  },
  status: 'running',
  installSpec: `${rootPackage.name}@${version}`,
  installedNativePackage: null,
  error: null
};

try {
  assertSupportedNodeRuntime();
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`
  );

  run(
    'npm',
    ['install', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', report.installSpec],
    { cwd: appDir }
  );

  const installedPackageDir = path.join(appDir, 'node_modules', rootPackage.name);
  const installedPackageJson = readJson(path.join(installedPackageDir, 'package.json'));
  assert.equal(installedPackageJson.name, rootPackage.name);
  assert.equal(installedPackageJson.version, version);
  assert.equal(
    installedPackageJson.optionalDependencies[target.packageName],
    version,
    `${target.packageName} optional dependency should match root package version`
  );

  const installedNativePackageDir = path.join(appDir, 'node_modules', target.packageName);
  const installedNativePackageJson = readJson(path.join(installedNativePackageDir, 'package.json'));
  assert.equal(installedNativePackageJson.name, target.packageName);
  assert.equal(installedNativePackageJson.version, version);
  assert.deepEqual(installedNativePackageJson.os, ['linux']);
  assert.deepEqual(installedNativePackageJson.cpu, [target.cpu]);
  assert.deepEqual(installedNativePackageJson.libc, [target.libc]);
  assert.equal(
    fs.existsSync(path.join(installedNativePackageDir, target.nativeFile)),
    true,
    `${target.packageName} native binding is missing`
  );
  report.installedNativePackage = target.packageName;

  const embeddedNative = path.join(installedPackageDir, target.nativeFile);
  assert.equal(
    fs.existsSync(embeddedNative),
    false,
    'root package must not ship the platform native binding'
  );

  runSmokeScript(target);
  runCommonJsExportsSmoke(installedPackageDir);
  runEsmSmoke(target);
  runCliSmoke(appDir);

  report.status = 'passed';
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `registry install smoke ok (${rootPackage.name}@${version}, ${target.packageName})`
    );
  }
} catch (error) {
  report.status = 'failed';
  report.error = {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.error(report.error.message);
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runSmokeScript(nativeTarget) {
  const smokeScript = `
    'use strict';

    const assert = require('node:assert/strict');
    const net = require('node:net');
    const optionalPackageJson = require(${JSON.stringify(`${nativeTarget.packageName}/package.json`)});
    assert.equal(optionalPackageJson.version, ${JSON.stringify(version)});

    const ferrings = require('ferrings');
    assert.equal(typeof ferrings.createTcpServer, 'function');
    assert.equal(typeof ferrings.capabilities, 'function');

    const caps = ferrings.capabilities();
    assert.equal(typeof caps.ioUringAvailable, 'boolean');

    const server = ferrings.createTcpServer((connection) => {
      connection.on('data', (data) => {
        connection.end('registry:' + data.toString('utf8'));
      });
    });

    const timeout = setTimeout(() => {
      try {
        server.close();
      } finally {
        throw new Error('registry install smoke timed out');
      }
    }, 5000);

    server.listen(0, '127.0.0.1');
    const info = server.info();
    assert.equal(info.backend, 'io_uring');

    const socket = net.createConnection({ host: '127.0.0.1', port: info.port }, () => {
      socket.write('ok');
    });

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      try {
        assert.equal(body.toString('utf8'), 'registry:ok');
        clearTimeout(timeout);
        server.close();
      } catch (error) {
        clearTimeout(timeout);
        server.close();
        throw error;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      server.close();
      throw error;
    });
  `;

  run(process.execPath, ['-e', smokeScript], {
    cwd: appDir,
    env: {
      ...process.env,
      NAPI_RS_ENFORCE_VERSION_CHECK: '1'
    }
  });
}

function runCommonJsExportsSmoke(installedPackageDir) {
  const exportsScript = `
    'use strict';

    const assert = require('node:assert/strict');
    const path = require('node:path');
    const installedPackageDir = ${JSON.stringify(installedPackageDir)};

    const ferrings = require('ferrings');
    const native = require('ferrings/native');
    const nativeJs = require('ferrings/native.js');
    const tcpTransportFactory = require('ferrings/tcp-transport');
    const zcrxSmoke = require('ferrings/zcrx-smoke');

    assert.equal(typeof ferrings.UringTcpServer, 'function');
    assert.equal(ferrings.UringTcpServer, native.UringTcpServer);
    assert.equal(native.UringTcpEchoServer, nativeJs.UringTcpEchoServer);
    assert.equal(typeof tcpTransportFactory, 'function');
    assert.equal(typeof zcrxSmoke.runZcrxHardwareSmoke, 'function');
    assert.equal(require('ferrings/package.json').version, ${JSON.stringify(version)});
    assert.equal(require.resolve('ferrings'), path.join(installedPackageDir, 'index.js'));
    assert.equal(require.resolve('ferrings/native'), path.join(installedPackageDir, 'native.js'));
    assert.equal(require.resolve('ferrings/native.js'), path.join(installedPackageDir, 'native.js'));
    assert.equal(
      require.resolve('ferrings/tcp-transport'),
      path.join(installedPackageDir, 'tcp-transport.js')
    );
    assert.equal(
      require.resolve('ferrings/zcrx-smoke'),
      path.join(installedPackageDir, 'zcrx-smoke.js')
    );
    assert.equal(
      require.resolve('ferrings/bin/ferrings'),
      path.join(installedPackageDir, 'bin', 'ferrings.js')
    );
    assert.throws(
      () => require.resolve('ferrings/README.md'),
      (error) => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    );
  `;

  run(process.execPath, ['-e', exportsScript], {
    cwd: appDir,
    env: {
      ...process.env,
      NAPI_RS_ENFORCE_VERSION_CHECK: '1'
    }
  });
}

function runEsmSmoke(nativeTarget) {
  const esmScript = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import net from 'node:net';
    import ferrings, {
      UringTcpServer,
      capabilities,
      createTcpServer,
      IoUringTcpTransportServer,
      zcrxProbe as rootZcrxProbe
    } from 'ferrings';
    import native, {
      UringHttpServer,
      zcrxProbe
    } from 'ferrings/native';
    import nativeJs, {
      UringTcpEchoServer
    } from 'ferrings/native.js';
    import zcrxSmoke from 'ferrings/zcrx-smoke';

    const require = createRequire(import.meta.url);
    const optionalPackageJson = require(${JSON.stringify(`${nativeTarget.packageName}/package.json`)});

    assert.equal(optionalPackageJson.version, ${JSON.stringify(version)});
    assert.equal(ferrings.createTcpServer, createTcpServer);
    assert.equal(ferrings.UringTcpServer, UringTcpServer);
    assert.equal(ferrings.IoUringTcpTransportServer, IoUringTcpTransportServer);
    assert.equal(ferrings.zcrxProbe, rootZcrxProbe);
    assert.equal(native.UringHttpServer, UringHttpServer);
    assert.equal(native.zcrxProbe, zcrxProbe);
    assert.equal(nativeJs.UringTcpEchoServer, UringTcpEchoServer);
    assert.equal(typeof zcrxSmoke.runZcrxHardwareSmoke, 'function');
    assert.equal(typeof capabilities().ioUringAvailable, 'boolean');
    assert.throws(
      () => rootZcrxProbe({ rxQueue: -1 }),
      /zcrxProbe rxQueue must be an integer between 0 and 4294967295/
    );

    const server = createTcpServer((connection) => {
      connection.on('data', (data) => {
        connection.end('esm-registry:' + data.toString('utf8'));
      });
    });
    assert.ok(server instanceof IoUringTcpTransportServer);

    let closed = false;
    try {
      server.listen(0, '127.0.0.1');
      const info = server.info();
      assert.equal(info.backend, 'io_uring');
      const body = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('registry ESM smoke timed out'));
        }, 5000);
        const socket = net.createConnection({ host: '127.0.0.1', port: info.port }, () => {
          socket.write('ok');
        });
        let response = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          response = Buffer.concat([response, chunk]);
        });
        socket.on('end', () => {
          clearTimeout(timeout);
          resolve(response.toString('utf8'));
        });
        socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      assert.equal(body, 'esm-registry:ok');
    } finally {
      if (!closed) {
        closed = true;
        server.close();
      }
    }
  `;

  run(process.execPath, ['--input-type=module', '-e', esmScript], {
    cwd: appDir,
    env: {
      ...process.env,
      NAPI_RS_ENFORCE_VERSION_CHECK: '1'
    }
  });
}

function runCliSmoke(cwd) {
  const binPath = path.join(cwd, 'node_modules', '.bin', 'ferrings');
  const versionResult = run(process.execPath, [binPath, '--version'], { cwd });
  assert.equal(versionResult.stdout.trim(), `${rootPackage.name} ${version}`);

  const result = run(process.execPath, [binPath, 'capabilities', '--json'], { cwd });
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.package, rootPackage.name);
  assert.equal(capabilities.version, version);
  assert.equal(capabilities.mode, 'capabilities');
  assert.equal(typeof capabilities.capabilities.ioUringAvailable, 'boolean');

  const doctorResult = run(process.execPath, [binPath, 'doctor', '--interface', 'lo', '--json'], {
    cwd
  });
  const doctor = JSON.parse(doctorResult.stdout);
  assert.equal(doctor.package, rootPackage.name);
  assert.equal(doctor.version, version);
  assert.equal(doctor.mode, 'doctor');
  assert.equal(doctor.zcrx.interfaceName, 'lo');
  assert.equal(typeof doctor.transport.ready, 'boolean');
  assert.equal(typeof doctor.nextCommand, 'string');

  const probeResult = run(process.execPath, [binPath, 'zcrx-probe', '-i', 'lo', '--json'], {
    cwd
  });
  const probe = JSON.parse(probeResult.stdout);
  assert.equal(probe.package, rootPackage.name);
  assert.equal(probe.version, version);
  assert.equal(probe.mode, 'zcrx-probe');
  assert.equal(probe.probe.interfaceName, 'lo');

  const smokeResult = run(process.execPath, [binPath, 'zcrx-smoke', '--json'], { cwd });
  const smoke = JSON.parse(smokeResult.stdout);
  assert.equal(smoke.status, 'skipped');
  assert.match(smoke.skippedReason, /ZCRX_INTERFACE|--interface/);
}

function detectNativeTarget() {
  assert.equal(process.platform, 'linux', 'registry install smoke currently requires Linux');
  const arch = process.arch;
  assert.ok(arch === 'x64' || arch === 'arm64', `unsupported Linux arch ${arch}`);
  const report = process.report?.getReport?.();
  const libc = report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
  const platform = `linux-${arch}-${libc}`;
  return {
    platform,
    packageName: `ferrings-${platform}`,
    nativeFile: `ferrings.${platform}.node`,
    cpu: arch,
    libc: libc === 'gnu' ? 'glibc' : 'musl'
  };
}

function assertSupportedNodeRuntime() {
  const support = runtimeSupport(rootPackage);
  if (support.ok) return;
  throw new Error(
    `registry install smoke must run on a supported Node.js major. ${support.detail} ` +
      'npm may skip optional native packages when engines do not match.'
  );
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}
