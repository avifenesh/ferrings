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
  zcrxProbe,
  IoUringTcpConnection: tcpTransport.IoUringTcpConnection,
  IoUringTcpTransportServer: tcpTransport.IoUringTcpTransportServer,
  createTcpServer: tcpTransport.createTcpServer
};

function zcrxProbe(options) {
  return nativeBinding.zcrxProbe(normalizeZcrxProbeOptions(options));
}

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

function normalizeZcrxProbeOptions(options) {
  if (options === undefined || options === null) return options;
  if (!isPlainObject(options)) {
    throw new TypeError('zcrxProbe options must be an object');
  }

  const normalized = { ...options };
  if (normalized.interfaceName !== undefined && normalized.interfaceName !== null) {
    if (
      typeof normalized.interfaceName !== 'string' ||
      normalized.interfaceName.length === 0
    ) {
      throw new TypeError('zcrxProbe interfaceName must be a non-empty string');
    }
  }
  if (normalized.rxQueue !== undefined && normalized.rxQueue !== null) {
    normalized.rxQueue = uint32Option('zcrxProbe rxQueue', normalized.rxQueue);
  }
  if (normalized.rxBufferSize !== undefined && normalized.rxBufferSize !== null) {
    normalized.rxBufferSize = uint32Option('zcrxProbe rxBufferSize', normalized.rxBufferSize);
  }
  if (normalized.activeRegistration !== undefined && normalized.activeRegistration !== null) {
    if (typeof normalized.activeRegistration !== 'boolean') {
      throw new TypeError('zcrxProbe activeRegistration must be a boolean');
    }
  }
  return normalized;
}

function uint32Option(name, value) {
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an integer between 0 and 4294967295`);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
