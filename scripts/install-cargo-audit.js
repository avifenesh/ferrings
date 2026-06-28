#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const expectedVersion = process.env.CARGO_AUDIT_VERSION || '0.22.2';
const checkOnly = process.argv.includes('--check-only');

main();

function main() {
  const current = currentCargoAuditVersion();
  if (current === expectedVersion) {
    console.log(`cargo-audit ${expectedVersion} is installed`);
    return;
  }

  if (checkOnly) {
    const found = current ? `found ${current}` : 'not installed';
    console.error(`cargo-audit ${expectedVersion} is required (${found})`);
    process.exitCode = 1;
    return;
  }

  installCargoAudit();

  const installed = currentCargoAuditVersion();
  if (installed !== expectedVersion) {
    const found = installed ? `found ${installed}` : 'not installed';
    console.error(`cargo-audit ${expectedVersion} installation did not verify (${found})`);
    process.exitCode = 1;
    return;
  }

  console.log(`cargo-audit ${expectedVersion} is installed`);
}

function currentCargoAuditVersion() {
  const result = spawnSync('cargo', ['audit', '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
}

function installCargoAudit() {
  const result = spawnSync(
    'cargo',
    ['install', 'cargo-audit', '--locked', '--version', expectedVersion, '--force'],
    {
      encoding: 'utf8',
      stdio: 'inherit'
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
