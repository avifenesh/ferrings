'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const npmRoot = path.join(repoRoot, 'npm');
const packageDirs = fs
  .readdirSync(npmRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(npmRoot, entry.name));

for (const packageDir of packageDirs) {
  for (const fileName of ['LICENSE-APACHE', 'LICENSE-MIT']) {
    fs.copyFileSync(path.join(repoRoot, fileName), path.join(packageDir, fileName));
  }
}

console.log(`copied native package assets (${packageDirs.length} packages)`);
