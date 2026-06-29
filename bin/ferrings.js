#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const pkg = require('../package.json');

const UINT32_MAX = 0xffffffff;
const MAX_TIMEOUT_MS = 0x7fffffff;
let ferringsModule = null;
let zcrxSmokeModule = null;

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const args = process.argv.slice(2);
const command = parseCommand(args);

main().catch((error) => {
  handleError(error);
});

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'version') {
    runVersion(args);
  } else if (command === 'capabilities' || command === 'caps') {
    runCapabilities(args);
  } else if (command === 'doctor') {
    runDoctor(args);
  } else if (command === 'zcrx-probe' || command === 'zcrx') {
    runZcrxProbe(args);
  } else if (command === 'zcrx-smoke') {
    await runZcrxSmoke(args);
  } else {
    throw new CliError(`unknown command: ${command}`, 64);
  }
}

function parseCommand(rawArgs) {
  const first = rawArgs[0];
  if (first === '--version' || first === '-v') {
    rawArgs.shift();
    return 'version';
  }
  return first && !first.startsWith('-') ? rawArgs.shift() : 'capabilities';
}

function handleError(error) {
  console.error(error.message || String(error));
  if (!(error instanceof CliError)) {
    console.error(error.stack);
  }
  process.exitCode = error.exitCode || 1;
}

function runVersion(rawArgs) {
  if (rawArgs.length > 0) {
    throw new CliError(`unexpected argument: ${rawArgs[0]}`, 64);
  }
  console.log(`${pkg.name} ${pkg.version}`);
}

function runCapabilities(rawArgs) {
  const options = parseFlags(rawArgs, {
    booleans: ['json', 'compact', 'help']
  });
  if (options.help) {
    printHelp();
    return;
  }
  const report = baseReport('capabilities');
  try {
    report.capabilities = loadFerrings().capabilities();
  } catch (error) {
    report.capabilities = null;
    report.ready = false;
    report.nativeLoadError = nativeLoadErrorForReport(error);
    if (options.json || options.compact) {
      printJson(report, options.compact);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (options.json || options.compact) {
    printJson(report, options.compact);
    return;
  }
  printCapabilities(report.capabilities);
}

function runDoctor(rawArgs) {
  const options = parseFlags(rawArgs, {
    booleans: ['active', 'compact', 'help', 'json', 'require-ready', 'require-zcrx'],
    values: ['interface', 'rx-queue', 'rx-buffer-size']
  });
  if (options.help) {
    printHelp();
    return;
  }

  const report = buildDoctorReport(options);
  if (options.json || options.compact) {
    printJson(report, options.compact);
  } else {
    printDoctorReport(report);
  }

  if (options['require-ready'] && !report.ready) {
    throw new CliError('doctor readiness requirements were not met', 2);
  }
}

function runZcrxProbe(rawArgs) {
  const options = parseFlags(rawArgs, {
    booleans: ['active', 'all', 'compact', 'help', 'json', 'require-ready'],
    values: ['interface', 'rx-queue', 'rx-buffer-size']
  });
  if (options.help) {
    printHelp();
    return;
  }

  const report = baseReport('zcrx-probe');
  let ferrings;
  try {
    ferrings = loadFerrings();
    report.capabilities = ferrings.capabilities();
  } catch (error) {
    report.capabilities = null;
    report.ready = false;
    report.nativeLoadError = nativeLoadErrorForReport(error);
    if (options.json || options.compact) {
      printJson(report, options.compact);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const probeOptions = {
    rxQueue: numberOption(options['rx-queue'], 'rx-queue', 0, UINT32_MAX),
    rxBufferSize: numberOption(options['rx-buffer-size'], 'rx-buffer-size', 0, UINT32_MAX),
    activeRegistration: Boolean(options.active)
  };

  if (options.all) {
    report.probes = listInterfaces().map((interfaceName) =>
      ferrings.zcrxProbe({
        ...probeOptions,
        interfaceName
      })
    );
  } else {
    report.probe = ferrings.zcrxProbe({
      ...probeOptions,
      interfaceName: options.interface
    });
  }

  const probes = report.probes || [report.probe];
  report.ready = probes.every((probe) => probe && probe.ready);
  if (options.json || options.compact) {
    printJson(report, options.compact);
  } else {
    printZcrxReport(report);
  }

  if (options['require-ready'] && !report.ready) {
    throw new CliError('ZCRX readiness requirements were not met', 2);
  }
}

async function runZcrxSmoke(rawArgs) {
  const options = parseFlags(rawArgs, {
    booleans: [
      'compact',
      'help',
      'json',
      'require-rx-queue-stats',
      'self-test'
    ],
    values: [
      'bind-host',
      'connect-host',
      'interface',
      'report-path',
      'rx-buffer-size',
      'rx-queue',
      'timeout-ms'
    ]
  });
  if (options.help) {
    printHelp();
    return;
  }
  if (options['self-test']) {
    loadZcrxSmoke().runQueueStatsParserSelfTest();
    console.log('zcrx smoke self-test ok');
    return;
  }

  try {
    const report = await loadZcrxSmoke().runZcrxHardwareSmoke({
      interfaceName: options.interface,
      rxQueue: numberOption(options['rx-queue'], 'rx-queue', 0, UINT32_MAX),
      rxBufferSize: numberOption(options['rx-buffer-size'], 'rx-buffer-size', 0, UINT32_MAX),
      bindHost: options['bind-host'],
      connectHost: options['connect-host'],
      timeoutMs: numberOption(options['timeout-ms'], 'timeout-ms', 1, MAX_TIMEOUT_MS),
      requireRxQueueStats: Boolean(options['require-rx-queue-stats']),
      reportPath: options['report-path']
    });
    if (options.json || options.compact) {
      printJson(report, options.compact);
    } else {
      printZcrxSmokeReport(report);
    }
  } catch (error) {
    if (error.report && (options.json || options.compact)) {
      printJson(error.report, options.compact);
    }
    if (!(error instanceof CliError)) {
      error.exitCode = 1;
    }
    throw error;
  }
}

function baseReport(mode) {
  return {
    package: pkg.name,
    version: pkg.version,
    mode,
    generatedAt: new Date().toISOString()
  };
}

function buildDoctorReport(options) {
  const report = baseReport('doctor');
  const requireZcrx = Boolean(options['require-zcrx']);
  const probeOptions = {
    interfaceName: options.interface,
    rxQueue: numberOption(options['rx-queue'], 'rx-queue', 0, UINT32_MAX),
    rxBufferSize: numberOption(options['rx-buffer-size'], 'rx-buffer-size', 0, UINT32_MAX),
    activeRegistration: Boolean(options.active)
  };
  let ferrings;
  try {
    ferrings = loadFerrings();
  } catch (error) {
    return buildNativeLoadDoctorReport(report, requireZcrx, probeOptions, error);
  }
  report.capabilities = ferrings.capabilities();
  report.transport = buildTransportVerdict(report.capabilities);
  report.zcrx = ferrings.zcrxProbe(probeOptions);
  report.zcrxRequired = requireZcrx;
  report.defaultReady = report.transport.ready;
  report.ready = report.transport.ready && (!requireZcrx || report.zcrx.ready);
  report.verdict = doctorVerdict(report);
  report.blockers = [
    ...report.transport.blockers,
    ...(requireZcrx ? report.zcrx.blockers : [])
  ];
  report.optionalBlockers = requireZcrx || report.zcrx.ready ? [] : report.zcrx.blockers;
  report.warnings = [
    ...report.transport.warnings,
    ...(report.zcrx.kernelSecurityWarnings || [])
  ];
  report.nextCommand = doctorNextCommand(report, probeOptions);
  return report;
}

function buildNativeLoadDoctorReport(report, requireZcrx, probeOptions, error) {
  const blocker = nativeLoadBlocker(error);
  report.capabilities = null;
  report.nativeLoadError = nativeLoadErrorForReport(error);
  report.transport = {
    ready: false,
    blockers: [blocker],
    warnings: []
  };
  report.zcrx = {
    interfaceName: probeOptions.interfaceName,
    interfaceIndex: 0,
    kernelOpcode: false,
    interfaceExists: false,
    rxQueue: probeOptions.rxQueue || 0,
    rxBufferSize: probeOptions.rxBufferSize || 0,
    rxQueueCount: 0,
    isLoopback: false,
    isVirtual: false,
    ethtoolAvailable: false,
    headerDataSplit: 'unknown',
    flowSteering: 'unknown',
    activeRegistration: Boolean(probeOptions.activeRegistration),
    kernelSecurityWarnings: [],
    ready: false,
    blockers: ['native binding did not load'],
    note: 'ZCRX cannot be probed until the ferrings native binding loads'
  };
  report.zcrxRequired = requireZcrx;
  report.defaultReady = false;
  report.ready = false;
  report.verdict = 'native-load-blocked';
  report.blockers = [blocker];
  report.optionalBlockers = [];
  report.warnings = [];
  report.nextCommand = nativeLoadNextCommand();
  return report;
}

function buildTransportVerdict(caps) {
  const blockers = [];
  const warnings = [];
  if (caps.platform !== 'linux') {
    blockers.push('ferrings transport requires Linux');
  }
  if (!caps.ioUringAvailable) {
    blockers.push('io_uring is not available');
  }
  if (!caps.acceptMulti) {
    blockers.push('multishot accept is not available');
  }
  if (!caps.recvMulti) {
    blockers.push('multishot recv is not available');
  }
  if (!caps.send) {
    blockers.push('io_uring send is not available');
  }
  if (!caps.providedBufferRing) {
    warnings.push('provided-buffer ring registration failed; servers will use the legacy provided-buffer fallback');
  }
  if (!caps.sendZc) {
    warnings.push('IORING_OP_SEND_ZC is unavailable; zero-copy send will fall back or fail when required');
  }
  if (!caps.registeredSendBuffer) {
    warnings.push(`registered fixed-buffer send probe failed: ${caps.registeredSendBufferProbe}`);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings
  };
}

function doctorVerdict(report) {
  if (!report.transport.ready) return 'transport-blocked';
  if (report.zcrx.ready) return 'ready';
  if (report.zcrxRequired) return 'zcrx-blocked';
  return 'ready-zcrx-optional-blocked';
}

function doctorNextCommand(report, probeOptions) {
  if (!report.transport.ready) {
    return 'ferrings capabilities --json';
  }
  const interfaceName = report.zcrx.interfaceName || probeOptions.interfaceName;
  const rxQueue = report.zcrx.rxQueue;
  const rxBufferSize = report.zcrx.rxBufferSize;
  if (!report.zcrx.ready) {
    const command = commandLine([
      'ferrings',
      'zcrx-probe',
      ...(interfaceName ? ['--interface', interfaceName] : ['--interface', '<nic>']),
      '--rx-queue',
      String(rxQueue),
      ...(rxBufferSize ? ['--rx-buffer-size', String(rxBufferSize)] : []),
      '--active',
      '--json'
    ]);
    if (!report.zcrxRequired) {
      return `default transport is ready; run ${command} only before enabling ZCRX`;
    }
    if ((report.zcrx.kernelSecurityWarnings || []).length > 0) {
      return 'upgrade to a ZCRX-fixed kernel or set FERRINGS_ZCRX_ALLOW_KERNEL_SECURITY_RISK=1 only after verifying a vendor backport';
    }
    return command;
  }
  return commandLine([
    'ferrings',
    'zcrx-smoke',
    '--interface',
    interfaceName || '<nic>',
    '--rx-queue',
    String(rxQueue),
    ...(rxBufferSize ? ['--rx-buffer-size', String(rxBufferSize)] : []),
    '--connect-host',
    '<host-routed-to-nic>',
    '--json'
  ]);
}

function commandLine(parts) {
  return parts.map(quoteCommandArg).join(' ');
}

function quoteCommandArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value) || /^<[^>\s]+>$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseFlags(rawArgs, schema) {
  const options = {};
  const booleans = new Set(schema.booleans || []);
  const values = new Set(schema.values || []);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith('-')) {
      throw new CliError(`unexpected argument: ${arg}`, 64);
    }
    const flag = parseFlagToken(arg);
    const rawName = flag.rawName;
    const inlineValue = flag.inlineValue;
    const name = normalizeFlagName(rawName);
    if (booleans.has(name)) {
      options[name] = inlineValue === undefined ? true : inlineValue !== 'false';
    } else if (values.has(name)) {
      const value = inlineValue === undefined ? rawArgs[++index] : inlineValue;
      if (value === undefined || value.startsWith('-')) {
        throw new CliError(`${flag.displayName} requires a value`, 64);
      }
      options[name] = value;
    } else {
      throw new CliError(`unknown option: ${flag.displayName}`, 64);
    }
  }
  return options;
}

function parseFlagToken(arg) {
  const isLong = arg.startsWith('--');
  const prefix = isLong ? '--' : '-';
  const body = arg.slice(prefix.length);
  if (body.length === 0) {
    throw new CliError(`unknown option: ${arg}`, 64);
  }
  const [rawName, inlineValue] = body.split(/=(.*)/s, 2);
  return {
    rawName,
    inlineValue,
    displayName: `${prefix}${rawName}`
  };
}

function normalizeFlagName(name) {
  if (name === 'interface-name') return 'interface';
  if (name === 'i') return 'interface';
  if (name === 'h') return 'help';
  return name;
}

function numberOption(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new CliError(`--${name} must be an integer between ${min} and ${max}`, 64);
  }
  return number;
}

function listInterfaces() {
  const root = '/sys/class/net';
  try {
    return fs
      .readdirSync(root)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

function printCapabilities(caps) {
  console.log(`ferrings ${pkg.version}`);
  console.log(`platform: ${caps.platform}`);
  console.log(`kernel: ${caps.kernelRelease}`);
  console.log(`io_uring: ${yesNo(caps.ioUringAvailable)}`);
  console.log(`multishot accept: ${yesNo(caps.acceptMulti)}`);
  console.log(`multishot recv: ${yesNo(caps.recvMulti)}`);
  console.log(`provided buffer ring: ${yesNo(caps.providedBufferRing)} (${caps.providedBufferRingProbe})`);
  console.log(`recv bundle: ${yesNo(caps.recvBundle)}`);
  console.log(`send zc: ${yesNo(caps.sendZc)}`);
  console.log(`registered send buffer: ${yesNo(caps.registeredSendBuffer)} (${caps.registeredSendBufferProbe})`);
  console.log(`recv zc opcode: ${yesNo(caps.recvZc)}`);
  console.log(`ZCRX CQE32 ring: ${yesNo(caps.zcrxCqe32Ring)} (${caps.zcrxCqe32RingProbe})`);
  for (const warning of caps.zcrxKernelSecurityWarnings || []) {
    console.log(`ZCRX kernel security warning: ${warning}`);
  }
}

function printZcrxReport(report) {
  printCapabilities(report.capabilities);
  const probes = report.probes || [report.probe];
  console.log('');
  for (const probe of probes) {
    console.log(`ZCRX interface: ${probe.interfaceName || '(none)'}`);
    console.log(`  ready: ${yesNo(probe.ready)}`);
    console.log(`  ifindex: ${probe.interfaceIndex}`);
    console.log(`  operstate: ${probe.operstate || 'unknown'}`);
    console.log(`  driver: ${probe.driver || 'unknown'}`);
    console.log(`  rx queue: ${probe.rxQueue}/${probe.rxQueueCount}`);
    console.log(`  rx buffer size: ${probe.rxBufferSize}`);
    console.log(`  header/data split: ${probe.headerDataSplit}`);
    console.log(`  flow steering: ${probe.flowSteering}`);
    if (probe.activeRegistration) {
      console.log(`  active registration: ${probe.activeRegistrationResult || 'unknown'}`);
    }
    for (const warning of probe.kernelSecurityWarnings || []) {
      console.log(`  security warning: ${warning}`);
    }
    if (probe.blockers.length > 0) {
      console.log('  blockers:');
      for (const blocker of probe.blockers) {
        console.log(`    - ${blocker}`);
      }
    }
  }
}

function printDoctorReport(report) {
  printCapabilities(report.capabilities);
  console.log('');
  console.log(`doctor verdict: ${report.verdict}`);
  console.log(`ready: ${report.ready ? 'yes' : 'no'}`);
  console.log(`default transport ready: ${report.defaultReady ? 'yes' : 'no'}`);
  console.log(`ZCRX required: ${report.zcrxRequired ? 'yes' : 'no'}`);
  console.log(`transport core: ${report.transport.ready ? 'ready' : 'blocked'}`);
  for (const blocker of report.transport.blockers) {
    console.log(`  blocker: ${blocker}`);
  }
  for (const warning of report.transport.warnings) {
    console.log(`  warning: ${warning}`);
  }
  console.log(`ZCRX: ${report.zcrx.ready ? 'ready' : 'blocked'}`);
  console.log(`  interface: ${report.zcrx.interfaceName || '(none)'}`);
  console.log(`  rx queue: ${report.zcrx.rxQueue}/${report.zcrx.rxQueueCount}`);
  console.log(`  rx buffer size: ${report.zcrx.rxBufferSize}`);
  console.log(`  active registration: ${report.zcrx.activeRegistration ? report.zcrx.activeRegistrationResult || 'unknown' : 'not requested'}`);
  for (const warning of report.zcrx.kernelSecurityWarnings || []) {
    console.log(`  security warning: ${warning}`);
  }
  for (const blocker of report.zcrx.blockers) {
    console.log(`  ${report.zcrxRequired ? 'blocker' : 'optional blocker'}: ${blocker}`);
  }
  console.log(`next: ${report.nextCommand}`);
}

function printZcrxSmokeReport(report) {
  if (report.status === 'skipped') {
    console.log(`ZCRX smoke skipped: ${report.skippedReason}`);
    return;
  }
  if (report.status === 'self-test') {
    console.log('ZCRX smoke self-test ok');
    return;
  }
  console.log(`ZCRX smoke status: ${report.status}`);
  console.log(`interface: ${report.config.interfaceName}`);
  console.log(`rx queue: ${report.config.rxQueue}`);
  console.log(`bind host: ${report.config.bindHost}`);
  console.log(`connect host: ${report.config.connectHost}`);
  if (report.probe) {
    console.log(`active registration: ${report.probe.activeRegistrationResult || 'unknown'}`);
  }
  for (const warning of report.warnings || []) {
    console.log(`warning: ${warning}`);
  }
  for (const smoke of report.smokes || []) {
    console.log(`${smoke.name}: ${smoke.status}`);
  }
  if (report.queueCounters && report.queueCounters.positiveDeltas.length > 0) {
    console.log(
      `rx queue counter evidence: ${report.queueCounters.positiveDeltas
        .map(({ name, delta }) => `${name}+${delta}`)
        .join(', ')}`
    );
  }
}

function printJson(value, compact) {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

function loadFerrings() {
  if (!ferringsModule) {
    ferringsModule = require('..');
  }
  return ferringsModule;
}

function loadZcrxSmoke() {
  if (!zcrxSmokeModule) {
    zcrxSmokeModule = require('../zcrx-smoke');
  }
  return zcrxSmokeModule;
}

function nativeLoadBlocker(error) {
  if (error && error.code === 'FERRINGS_NATIVE_LOAD_FAILED') {
    return firstLine(error.message);
  }
  return `ferrings native binding failed to load: ${firstLine(error && error.message ? error.message : String(error))}`;
}

function nativeLoadNextCommand() {
  return 'reinstall with optional dependencies enabled, for example npm install ferrings --include=optional';
}

function nativeLoadErrorForReport(error) {
  const report = {
    name: error && error.name ? error.name : 'Error',
    message: error && error.message ? error.message : String(error)
  };
  if (error && error.code) {
    report.code = error.code;
  }
  if (error && error.target) {
    report.target = error.target;
  }
  if (error && Array.isArray(error.nativePackages)) {
    report.nativePackages = error.nativePackages;
  }
  if (error && Array.isArray(error.loadErrors)) {
    report.loadErrors = error.loadErrors.map(nativeLoadAttemptForReport);
  }
  if (error && error.cause) {
    report.cause = {
      name: error.cause.name || 'Error',
      message: error.cause.message || String(error.cause)
    };
    if (error.cause.code) {
      report.cause.code = error.cause.code;
    }
  }
  return report;
}

function nativeLoadAttemptForReport(error) {
  const attempt = {
    name: error && error.name ? error.name : 'Error',
    message: firstLine(error && error.message ? error.message : String(error))
  };
  for (const field of ['code', 'errno', 'syscall', 'path']) {
    if (error && error[field] !== undefined) {
      attempt[field] = error[field];
    }
  }
  return attempt;
}

function firstLine(value) {
  return String(value || '').split('\n')[0] || 'unknown error';
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function printHelp() {
  console.log(`Usage:
  ferrings --version
  ferrings capabilities [--json|--compact]
  ferrings doctor [--interface <name>] [--rx-queue <n>] [--rx-buffer-size <n>] [--active] [--require-zcrx] [--require-ready] [--json|--compact]
  ferrings zcrx-probe [--interface <name>] [--rx-queue <n>] [--rx-buffer-size <n>] [--active] [--all] [--require-ready] [--json|--compact]
  ferrings zcrx-smoke [--interface <name>] [--connect-host <host>] [--bind-host <host>] [--rx-queue <n>] [--rx-buffer-size <n>] [--timeout-ms <n>] [--require-rx-queue-stats] [--report-path <path>] [--json|--compact]

Commands:
  version       Print the installed ferrings version.
  capabilities  Print kernel/io_uring feature probes.
  doctor        Print one installed-package transport/ZCRX readiness verdict.
  zcrx-probe    Print ZCRX NIC readiness probes.
  zcrx-smoke    Run HTTP/native echo/programmable TCP ZCRX traffic validation.

Options:
  --version, -v      Print the installed ferrings version.
  --json             Print a pretty JSON report.
  --compact          Print compact JSON.
  --interface, -i    Probe a specific interface.
  --rx-queue         Probe a specific RX queue.
  --rx-buffer-size   Try a specific ZCRX receive buffer size; 0 uses the kernel default.
  --active           Attempt short-lived active ZCRX IFQ registration.
  --all              Probe every interface under /sys/class/net.
  --require-zcrx     Make ZCRX readiness part of the doctor ready verdict.
  --require-ready    Exit 2 when the selected readiness verdict is not ready.
  --connect-host     Required when --interface is set; must be non-loopback traffic routed through the selected NIC path.
  --bind-host        Host used by zcrx-smoke servers; defaults to 0.0.0.0.
  --timeout-ms       Per-request zcrx-smoke timeout.
  --report-path      Write the zcrx-smoke JSON report to a file.
  --self-test        Run the zcrx-smoke parser self-test.
`);
}
