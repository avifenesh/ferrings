'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const json = args.includes('--json');

const SECRET_PATTERNS = [
  {
    name: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g
  },
  {
    name: 'AWS access key id',
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/g
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/g
  },
  {
    name: 'npm token assignment',
    pattern: /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*=\s*(?:npm_[A-Za-z0-9]{30,}|[A-Za-z0-9+/=]{40,})\b/g
  },
  {
    name: 'npmrc auth token',
    pattern: /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(?!\$\{)[^\s]+/g
  }
];

if (require.main === module) {
  const findings = scanTrackedFiles();
  if (json) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  }
  if (findings.length > 0) {
    if (!json) {
      for (const finding of findings) {
        console.error(
          `${finding.file}:${finding.line}:${finding.column}: ${finding.name} (${finding.preview})`
        );
      }
    }
    process.exitCode = 1;
  } else if (!json) {
    console.log('secret scan ok (tracked files)');
  }
}

function scanTrackedFiles() {
  return scanFiles(listTrackedFiles());
}

function scanFiles(files) {
  const findings = [];
  for (const file of files) {
    const absolute = path.resolve(repoRoot, file);
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) {
      continue;
    }
    findings.push(...scanContent(buffer.toString('utf8'), file));
  }
  return findings;
}

function scanContent(content, file = '<content>') {
  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const value = match[1] || match[0];
      const location = lineColumn(content, match.index || 0);
      findings.push({
        file,
        line: location.line,
        column: location.column,
        name,
        preview: maskSecret(value)
      });
    }
  }
  return findings;
}

function listTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.status, 0, result.stderr.toString('utf8').trim());
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function lineColumn(content, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function maskSecret(value) {
  if (value.length <= 12) {
    return '<redacted>';
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

module.exports = {
  SECRET_PATTERNS,
  scanContent,
  scanFiles,
  scanTrackedFiles
};
