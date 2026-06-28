'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(repoRoot, 'scripts', 'install-cargo-zigbuild.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-cargo-zigbuild-'));
const binDir = path.join(tmpDir, 'bin');
const stateFile = path.join(tmpDir, 'state.json');
const logFile = path.join(tmpDir, 'cargo.log');

fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ version: '0.22.0' }));

const fakeCargoZigbuild = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_CARGO_ZIGBUILD_STATE, 'utf8'));
if (process.argv[2] === '--version') {
  console.log('cargo-zigbuild ' + state.version);
  process.exit(0);
}
console.error('unexpected cargo-zigbuild invocation: ' + process.argv.slice(2).join(' '));
process.exit(42);
`;

const fakeCargo = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const stateFile = process.env.FAKE_CARGO_ZIGBUILD_STATE;
const logFile = process.env.FAKE_CARGO_ZIGBUILD_LOG;
const expected = process.env.CARGO_ZIGBUILD_VERSION || '0.23.0';
const args = process.argv.slice(2);

if (
  args[0] === 'install' &&
  args[1] === 'cargo-zigbuild' &&
  args.includes('--locked') &&
  args.includes('--force') &&
  args.includes('--version') &&
  args[args.indexOf('--version') + 1] === expected
) {
  fs.appendFileSync(logFile, args.join(' ') + '\\n');
  fs.writeFileSync(stateFile, JSON.stringify({ version: expected }));
  process.exit(0);
}

console.error('unexpected cargo invocation: ' + args.join(' '));
process.exit(42);
`;

const fakeCargoZigbuildPath = path.join(binDir, 'cargo-zigbuild');
fs.writeFileSync(fakeCargoZigbuildPath, fakeCargoZigbuild);
fs.chmodSync(fakeCargoZigbuildPath, 0o755);

const fakeCargoPath = path.join(binDir, 'cargo');
fs.writeFileSync(fakeCargoPath, fakeCargo);
fs.chmodSync(fakeCargoPath, 0o755);

const env = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
  FAKE_CARGO_ZIGBUILD_STATE: stateFile,
  FAKE_CARGO_ZIGBUILD_LOG: logFile
};

const mismatch = run(['--check-only'], env);
assert.notEqual(mismatch.status, 0);
assert.match(mismatch.stderr, /cargo-zigbuild 0\.23\.0 is required \(found 0\.22\.0\)/);
assert.equal(fs.existsSync(logFile), false, 'check-only should not install cargo-zigbuild');

const install = run([], env);
assert.equal(install.status, 0, install.stderr || install.stdout);
assert.match(install.stdout, /cargo-zigbuild 0\.23\.0 is installed/);
assert.match(fs.readFileSync(logFile, 'utf8'), /install cargo-zigbuild --locked --version 0\.23\.0 --force/);

const installed = run(['--check-only'], env);
assert.equal(installed.status, 0, installed.stderr || installed.stdout);
assert.match(installed.stdout, /cargo-zigbuild 0\.23\.0 is installed/);

console.log('install cargo-zigbuild state ok');

function run(args, extraEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: extraEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}
