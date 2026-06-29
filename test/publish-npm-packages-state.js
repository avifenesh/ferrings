'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const rootPackage = require(path.join(repoRoot, 'package.json'));
const script = path.join(repoRoot, 'scripts', 'publish-npm-packages.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrings-publish-packages-'));
const preload = path.join(tmpDir, 'mock-spawn.js');

fs.writeFileSync(
  preload,
  `
    'use strict';

    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const originalSpawnSync = childProcess.spawnSync;
    const logFile = process.env.FERRINGS_TEST_PUBLISH_LOG;
    const existing = new Set((process.env.FERRINGS_TEST_EXISTING_PACKAGES || '').split(',').filter(Boolean));
    const viewErrors = new Set((process.env.FERRINGS_TEST_VIEW_ERROR_PACKAGES || '').split(',').filter(Boolean));
    const failPackage = process.env.FERRINGS_TEST_FAIL_PACKAGE || '';
    const failMode = process.env.FERRINGS_TEST_FAIL_MODE || '';
    const visibleAfterFailure = new Set((process.env.FERRINGS_TEST_VISIBLE_AFTER_FAILURE || '').split(',').filter(Boolean));
    const failedOnce = new Set();

    childProcess.spawnSync = function mockedSpawnSync(command, args = [], options = {}) {
      const commandArgs = args.map(String);
      if (command === 'npm' && commandArgs[0] === 'view') {
        return npmView(commandArgs.slice(1));
      }
      if (command === 'npm' && commandArgs[0] === 'publish') {
        return npmPublish(commandArgs, options);
      }
      return originalSpawnSync(command, args, options);
    };

    function npmView(args) {
      const { name, version } = parseSpec(args[0]);
      record({ kind: 'view', name, version });
      if (viewErrors.has(name)) {
        return done(1, '', 'npm ERR! code E500\\n');
      }
      if (existing.has(name)) {
        return done(0, JSON.stringify(version) + '\\n');
      }
      return done(1, '', 'npm ERR! code E404\\n');
    }

    function npmPublish(args, options) {
      const packageJson = require(path.join(options.cwd, 'package.json'));
      const rootSkip = options.env && options.env.FERRINGS_SKIP_OPTIONAL_PUBLISH === '1';
      record({ kind: 'publish', name: packageJson.name, args, rootSkip });

      if (packageJson.name === failPackage && !failedOnce.has(packageJson.name)) {
        failedOnce.add(packageJson.name);
        if (visibleAfterFailure.has(packageJson.name)) {
          existing.add(packageJson.name);
        }
        if (failMode === 'tlog') {
          return done(
            1,
            '',
            'npm error code TLOG_CREATE_ENTRY_ERROR\\nnpm error error creating tlog entry - (409) an equivalent entry already exists\\n'
          );
        }
        if (failMode === 'retryable') {
          return done(1, '', 'npm error code E500\\n');
        }
        return done(1, '', 'npm error code E400\\n');
      }

      existing.add(packageJson.name);
      return done(0, packageJson.name + ' published\\n');
    }

    function record(entry) {
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n');
    }

    function parseSpec(spec) {
      const at = String(spec).lastIndexOf('@');
      return {
        name: String(spec).slice(0, at),
        version: String(spec).slice(at + 1)
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
  const dryRun = runPublisher(['--dry-run', '--tag', 'latest']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunPublishes = dryRun.records.filter((entry) => entry.kind === 'publish');
  assert.deepEqual(
    dryRunPublishes.map((entry) => entry.name),
    [
      'ferrings-linux-arm64-gnu',
      'ferrings-linux-arm64-musl',
      'ferrings-linux-x64-gnu',
      'ferrings-linux-x64-musl',
      'ferrings'
    ]
  );
  assert.equal(dryRun.records.some((entry) => entry.kind === 'view'), false);
  assert.equal(dryRunPublishes.every((entry) => entry.args.includes('--dry-run')), true);
  assert.equal(dryRunPublishes.every((entry) => entry.args.includes('--json')), true);
  assert.equal(dryRunPublishes.find((entry) => entry.name === rootPackage.name).rootSkip, true);
  assert.equal(
    dryRunPublishes
      .filter((entry) => entry.name !== rootPackage.name)
      .every((entry) => entry.rootSkip === false),
    true
  );

  const skipExisting = runPublisher([], {
    FERRINGS_TEST_EXISTING_PACKAGES: 'ferrings-linux-arm64-gnu'
  });
  assert.equal(skipExisting.status, 0, skipExisting.stderr);
  assert.equal(
    skipExisting.records.some(
      (entry) => entry.kind === 'publish' && entry.name === 'ferrings-linux-arm64-gnu'
    ),
    false,
    'publisher must skip native packages that already exist'
  );
  assert.equal(
    skipExisting.records.some((entry) => entry.kind === 'publish' && entry.name === rootPackage.name),
    true,
    'publisher must still publish root package after skipping an existing native package'
  );

  const visibleAfterFailure = runPublisher([], {
    FERRINGS_TEST_FAIL_PACKAGE: 'ferrings-linux-arm64-gnu',
    FERRINGS_TEST_FAIL_MODE: 'plain',
    FERRINGS_TEST_VISIBLE_AFTER_FAILURE: 'ferrings-linux-arm64-gnu'
  });
  assert.equal(visibleAfterFailure.status, 0, visibleAfterFailure.stderr);
  assert.match(
    visibleAfterFailure.stdout,
    /became visible after publish failure/,
    'publisher should continue when a failed publish actually became visible'
  );

  const tlogFailure = runPublisher([], {
    FERRINGS_TEST_FAIL_PACKAGE: 'ferrings-linux-arm64-gnu',
    FERRINGS_TEST_FAIL_MODE: 'tlog'
  });
  assert.notEqual(tlogFailure.status, 0, 'tlog conflict should fail when the package is not visible');
  assert.match(
    tlogFailure.stderr,
    /transparency-log conflict.*bump the package version/s,
    'tlog conflict should tell maintainers to bump before retrying'
  );

  const viewFailure = runPublisher([], {
    FERRINGS_TEST_VIEW_ERROR_PACKAGES: 'ferrings-linux-arm64-gnu'
  });
  assert.notEqual(viewFailure.status, 0, 'npm view failures other than 404 should stop publishing');
  assert.match(viewFailure.stderr, /could not check ferrings-linux-arm64-gnu@.*E500/s);

  const retryable = runPublisher(['--retries', '2', '--retry-delay-ms', '1'], {
    FERRINGS_TEST_FAIL_PACKAGE: 'ferrings-linux-arm64-gnu',
    FERRINGS_TEST_FAIL_MODE: 'retryable'
  });
  assert.equal(retryable.status, 0, retryable.stderr);
  assert.equal(
    retryable.records.filter(
      (entry) => entry.kind === 'publish' && entry.name === 'ferrings-linux-arm64-gnu'
    ).length,
    2,
    'retryable publish failures should be retried'
  );

  console.log('publish npm packages state ok');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runPublisher(args = [], env = {}) {
  const logFile = path.join(tmpDir, `publish-${Date.now()}-${Math.random()}.jsonl`);
  const result = spawnSync(process.execPath, ['--require', preload, script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FERRINGS_TEST_PUBLISH_LOG: logFile,
      ...env
    },
    maxBuffer: 10 * 1024 * 1024
  });
  const records = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { ...result, records };
}
