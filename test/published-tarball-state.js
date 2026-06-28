'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'check-published.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-published-tarball-'));
const preload = path.join(tmpDir, 'mock-spawn.js');

fs.writeFileSync(
  preload,
  `
    'use strict';

    const childProcess = require('node:child_process');
    const path = require('node:path');
    const originalSpawnSync = childProcess.spawnSync;
    const rootPackage = require(path.resolve(process.cwd(), 'package.json'));
    const missingNative = process.env.FERRINGS_TEST_MISSING_NATIVE_TARBALL === '1';

    const targets = [
      {
        package: 'ferrings-linux-x64-gnu',
        platform: 'linux-x64-gnu',
        main: 'ferrings.linux-x64-gnu.node',
        cpu: ['x64'],
        libc: ['glibc']
      },
      {
        package: 'ferrings-linux-x64-musl',
        platform: 'linux-x64-musl',
        main: 'ferrings.linux-x64-musl.node',
        cpu: ['x64'],
        libc: ['musl']
      },
      {
        package: 'ferrings-linux-arm64-gnu',
        platform: 'linux-arm64-gnu',
        main: 'ferrings.linux-arm64-gnu.node',
        cpu: ['arm64'],
        libc: ['glibc']
      },
      {
        package: 'ferrings-linux-arm64-musl',
        platform: 'linux-arm64-musl',
        main: 'ferrings.linux-arm64-musl.node',
        cpu: ['arm64'],
        libc: ['musl']
      }
    ];

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'npm' && commandArgs[0] === 'view') {
        return npmView(commandArgs.slice(1));
      }
      if (command === 'npm' && commandArgs[0] === 'pack') {
        return npmPack(commandArgs.slice(1));
      }
      return originalSpawnSync(command, args, options);
    };

    function npmView(args) {
      if (args[0] === rootPackage.name && args[1] === 'dist-tags') {
        return done(0, JSON.stringify({ latest: rootPackage.version }) + '\\n');
      }

      const [name] = String(args[0]).split('@').filter(Boolean);
      if (name === rootPackage.name) {
        return done(0, JSON.stringify(rootMetadata()) + '\\n');
      }

      const target = targets.find((entry) => entry.package === name);
      if (target) {
        return done(0, JSON.stringify(nativeMetadata(target)) + '\\n');
      }

      return done(1, '', 'not found\\n');
    }

    function npmPack(args) {
      const [name] = String(args[0]).split('@').filter(Boolean);
      if (name === rootPackage.name) {
        return done(0, JSON.stringify([rootPack()]) + '\\n');
      }

      const target = targets.find((entry) => entry.package === name);
      if (target) {
        return done(0, JSON.stringify([nativePack(target)]) + '\\n');
      }

      return done(1, '', 'not found\\n');
    }

    function rootMetadata() {
      return {
        name: rootPackage.name,
        version: rootPackage.version,
        description: rootPackage.description,
        keywords: rootPackage.keywords,
        license: rootPackage.license,
        main: rootPackage.main,
        bin: rootPackage.bin,
        engines: rootPackage.engines,
        os: rootPackage.os,
        optionalDependencies: rootPackage.optionalDependencies,
        repository: rootPackage.repository,
        homepage: rootPackage.homepage,
        bugs: rootPackage.bugs,
        dist: dist()
      };
    }

    function nativeMetadata(target) {
      return {
        name: target.package,
        version: rootPackage.version,
        description: 'Native ferrings binding for ' + target.platform,
        keywords: rootPackage.keywords,
        license: rootPackage.license,
        main: target.main,
        engines: rootPackage.engines,
        os: ['linux'],
        cpu: target.cpu,
        libc: target.libc,
        repository: rootPackage.repository,
        homepage: rootPackage.homepage,
        bugs: rootPackage.bugs,
        dist: dist()
      };
    }

    function dist() {
      return {
        integrity: 'sha512-test',
        tarball: 'https://registry.npmjs.org/ferrings/-/ferrings.tgz',
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/ferrings',
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
        },
        signatures: [{ keyid: 'SHA256:test', sig: 'signature' }]
      };
    }

    function rootPack() {
      return {
        name: rootPackage.name,
        version: rootPackage.version,
        filename: 'ferrings.tgz',
        files: [
          'package.json',
          'README.md',
          'CHANGELOG.md',
          'CONTRIBUTING.md',
          'CODE_OF_CONDUCT.md',
          'SECURITY.md',
          'LICENSE-APACHE',
          'LICENSE-MIT',
          'index.js',
          'index.d.ts',
          'native.js',
          'native.d.ts',
          'tcp-transport.js',
          'zcrx-smoke.js',
          'bin/ferrings.js',
          'benchmark/compare.js',
          'benchmark/first-slice.js',
          'benchmark/high-concurrency.js',
          'benchmark/syscalls.js',
          'benchmark/tcp-echo.js',
          'examples/http-fixed.js',
          'examples/tcp-echo.js',
          'ferrings.linux-x64-gnu.node'
        ].map((file) => ({ path: file }))
      };
    }

    function nativePack(target) {
      const files = ['package.json', 'LICENSE-APACHE', 'LICENSE-MIT'];
      if (!(missingNative && target.package === 'ferrings-linux-arm64-musl')) {
        files.push(target.main);
      }
      return {
        name: target.package,
        version: rootPackage.version,
        filename: target.package + '.tgz',
        files: files.map((file) => ({ path: file }))
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
  const ok = runScenario(false);
  assert.equal(ok.status, 0, ok.stderr);
  const okReport = JSON.parse(ok.stdout);
  assert.equal(okReport.ok, true);
  assert.equal(okReport.verifyTarballs, true);
  assert.deepEqual(okReport.verifiedTarballs.sort(), [
    'ferrings',
    'ferrings-linux-arm64-gnu',
    'ferrings-linux-arm64-musl',
    'ferrings-linux-x64-gnu',
    'ferrings-linux-x64-musl'
  ]);

  const missing = runScenario(true);
  assert.equal(missing.status, 1);
  const missingReport = JSON.parse(missing.stdout);
  assert.equal(missingReport.ok, false);
  assert.match(
    missingReport.errors.join('\n'),
    /ferrings-linux-arm64-musl tarball is missing ferrings\.linux-arm64-musl\.node/
  );

  console.log('published tarball state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runScenario(missingNative) {
  return spawnSync(
    process.execPath,
    ['--require', preload, script, '--json', '--verify-tarballs'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FERRINGS_TEST_MISSING_NATIVE_TARBALL: missingNative ? '1' : '0'
      },
      maxBuffer: 5 * 1024 * 1024
    }
  );
}
