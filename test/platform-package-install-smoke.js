'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-platform-package-'));

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

try {
  const packDir = path.join(tmpRoot, 'pack');
  const appDir = path.join(tmpRoot, 'app');
  const nativePackageDir = path.join(tmpRoot, 'native-package');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(nativePackageDir, { recursive: true });

  const rootPack = run('npm', ['pack', '--pack-destination', packDir, '--json']);
  const [rootPacked] = JSON.parse(rootPack.stdout);
  assert.ok(rootPacked, 'root npm pack should report one package');
  const rootTarball = path.join(packDir, rootPacked.filename);

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
    fs.copyFileSync(source, path.join(nativePackageDir, fileName));
  }

  const nativePack = run('npm', [
    'pack',
    nativePackageDir,
    '--pack-destination',
    packDir,
    '--json'
  ]);
  const [nativePacked] = JSON.parse(nativePack.stdout);
  assert.ok(nativePacked, 'native npm pack should report one package');
  assert.equal(nativePacked.name, 'ferrings-linux-x64-gnu');
  const nativePackedFiles = new Set(nativePacked.files.map((file) => file.path));
  assert.equal(nativePackedFiles.has('ferrings.linux-x64-gnu.node'), true);
  assert.equal(nativePackedFiles.has('LICENSE-APACHE'), true);
  assert.equal(nativePackedFiles.has('LICENSE-MIT'), true);
  const nativeTarball = path.join(packDir, nativePacked.filename);

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`
  );
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', rootTarball, nativeTarball],
    { cwd: appDir }
  );

  const installedBaseDir = path.join(appDir, 'node_modules', 'ferrings');
  const installedNativePackageDir = path.join(
    appDir,
    'node_modules',
    'ferrings-linux-x64-gnu'
  );
  const embeddedNative = path.join(installedBaseDir, 'ferrings.linux-x64-gnu.node');
  const optionalNative = path.join(installedNativePackageDir, 'ferrings.linux-x64-gnu.node');
  assert.equal(fs.existsSync(embeddedNative), true);
  assert.equal(fs.existsSync(optionalNative), true);
  fs.rmSync(embeddedNative);
  assert.equal(fs.existsSync(embeddedNative), false);

  const smokeScript = `
    const assert = require('node:assert/strict');
    const net = require('node:net');
    const ferrings = require('ferrings');
    assert.equal(typeof ferrings.createTcpServer, 'function');
    assert.equal(typeof ferrings.capabilities, 'function');
    const caps = ferrings.capabilities();
    assert.equal(typeof caps.ioUringAvailable, 'boolean');
    const server = ferrings.createTcpServer((connection) => {
      connection.on('data', (data) => connection.end('platform:' + data.toString('utf8')));
    });
    server.listen(0, '127.0.0.1');
    const info = server.info();
    assert.equal(info.backend, 'io_uring');
    const socket = net.createConnection({ host: '127.0.0.1', port: info.port }, () => {
      socket.write('fallback');
    });
    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => {
      try {
        assert.equal(body.toString('utf8'), 'platform:fallback');
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
    cwd: appDir,
    env: {
      ...process.env,
      NAPI_RS_ENFORCE_VERSION_CHECK: '1'
    }
  });

  console.log('platform package install smoke ok');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
