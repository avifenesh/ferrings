'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  status: 'running',
  installSpec: `${rootPackage.name}@${version}`,
  installedNativePackage: null,
  error: null
};

try {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', report.installSpec], {
    cwd: appDir
  });

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
  fs.rmSync(embeddedNative, { force: true });
  assert.equal(fs.existsSync(embeddedNative), false);

  runSmokeScript(target);
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

function runCliSmoke(cwd) {
  const binPath = path.join(cwd, 'node_modules', '.bin', 'ferrings');
  const result = run(process.execPath, [binPath, 'capabilities', '--json'], { cwd });
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.package, rootPackage.name);
  assert.equal(capabilities.mode, 'capabilities');
  assert.equal(typeof capabilities.capabilities.ioUringAvailable, 'boolean');
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
