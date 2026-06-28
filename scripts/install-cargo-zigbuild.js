#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const expectedVersion = process.env.CARGO_ZIGBUILD_VERSION || '0.23.0';
const checkOnly = process.argv.includes('--check-only');

main();

function main() {
  const current = currentCargoZigbuildVersion();
  if (current === expectedVersion) {
    console.log(`cargo-zigbuild ${expectedVersion} is installed`);
    return;
  }

  if (checkOnly) {
    const found = current ? `found ${current}` : 'not installed';
    console.error(`cargo-zigbuild ${expectedVersion} is required (${found})`);
    process.exitCode = 1;
    return;
  }

  installCargoZigbuild();

  const installed = currentCargoZigbuildVersion();
  if (installed !== expectedVersion) {
    const found = installed ? `found ${installed}` : 'not installed';
    console.error(`cargo-zigbuild ${expectedVersion} installation did not verify (${found})`);
    process.exitCode = 1;
    return;
  }

  console.log(`cargo-zigbuild ${expectedVersion} is installed`);
}

function currentCargoZigbuildVersion() {
  const result = spawnSync('cargo-zigbuild', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || null;
}

function installCargoZigbuild() {
  const result = spawnSync(
    'cargo',
    ['install', 'cargo-zigbuild', '--locked', '--version', expectedVersion, '--force'],
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
