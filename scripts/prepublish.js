'use strict';

const { spawnSync } = require('node:child_process');

const dryRun =
  process.argv.includes('--dry-run') ||
  process.env.npm_config_dry_run === 'true' ||
  process.env.npm_config_dry_run === '1';
const skipOptionalPublish =
  dryRun ||
  process.argv.includes('--skip-optional-publish') ||
  process.env.FERRINGS_SKIP_OPTIONAL_PUBLISH === '1';

const args = ['napi', 'pre-publish', '-t', 'npm', '--no-gh-release'];
if (dryRun) {
  args.push('--dry-run');
}
if (skipOptionalPublish) {
  args.push('--skip-optional-publish');
}

const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}

process.exit(result.status === null ? 1 : result.status);
