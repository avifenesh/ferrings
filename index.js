'use strict';

const SUPPORTED_NATIVE_PACKAGES = [
  'ferrings-linux-x64-gnu',
  'ferrings-linux-x64-musl',
  'ferrings-linux-arm64-gnu',
  'ferrings-linux-arm64-musl'
];

const nativeBinding = loadNativeBinding();
const tcpTransport = require('./tcp-transport')(nativeBinding.UringTcpServer);

module.exports = {
  ...nativeBinding,
  IoUringTcpConnection: tcpTransport.IoUringTcpConnection,
  IoUringTcpTransportServer: tcpTransport.IoUringTcpTransportServer,
  createTcpServer: tcpTransport.createTcpServer
};

function loadNativeBinding() {
  try {
    return require('./native');
  } catch (error) {
    throw createNativeLoadError(error);
  }
}

function createNativeLoadError(cause) {
  const target = currentNativeTarget();
  const expectedPackages = expectedNativePackages(target);
  const lines = [
    `ferrings could not load its native Linux binding for ${target.platform}/${target.arch}/${target.libc}.`,
    `Supported native packages: ${SUPPORTED_NATIVE_PACKAGES.join(', ')}.`
  ];

  if (process.platform !== 'linux') {
    lines.push('ferrings currently supports Linux only.');
  } else if (expectedPackages.length === 0) {
    lines.push('This Linux architecture is not one of the published ferrings targets.');
  } else {
    lines.push(`Expected native package: ${expectedPackages.join(' or ')}.`);
  }

  lines.push(
    'Reinstall with optional dependencies enabled, for example `npm install ferrings`, and make sure your package manager is not using --omit=optional or --no-optional.'
  );

  if (cause && cause.message) {
    lines.push(`Original loader error: ${cause.message}`);
  }

  const error = new Error(lines.join('\n'));
  error.name = 'FerringsNativeLoadError';
  error.code = 'FERRINGS_NATIVE_LOAD_FAILED';
  error.cause = cause;
  error.target = target;
  error.nativePackages = SUPPORTED_NATIVE_PACKAGES.slice();
  return error;
}

function currentNativeTarget() {
  return {
    platform: process.platform,
    arch: process.arch,
    libc: detectLinuxLibc()
  };
}

function detectLinuxLibc() {
  if (process.platform !== 'linux') return 'n/a';
  try {
    if (process.report && typeof process.report.getReport === 'function') {
      const report = process.report.getReport();
      if (report && report.header && report.header.glibcVersionRuntime) {
        return 'gnu';
      }
      if (
        report &&
        Array.isArray(report.sharedObjects) &&
        report.sharedObjects.some((file) => /(?:^|\/)(?:ld-musl-|libc\.musl-)/.test(file))
      ) {
        return 'musl';
      }
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

function expectedNativePackages(target) {
  if (target.platform !== 'linux') return [];
  if (target.arch !== 'x64' && target.arch !== 'arm64') return [];
  if (target.libc === 'gnu' || target.libc === 'musl') {
    return [`ferrings-linux-${target.arch}-${target.libc}`];
  }
  return [`ferrings-linux-${target.arch}-gnu`, `ferrings-linux-${target.arch}-musl`];
}
