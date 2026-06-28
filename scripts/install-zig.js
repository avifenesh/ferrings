'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const defaultVersion = '0.13.0';
const sourceName = 'ferrings-ci';

const releases = {
  '0.13.0': {
    'linux-x64': {
      filename: 'zig-linux-x86_64-0.13.0.tar.xz',
      topLevelDirectory: 'zig-linux-x86_64-0.13.0',
      sha256: 'd45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea',
      size: 47082308,
      officialUrl: 'https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz'
    },
    'linux-arm64': {
      filename: 'zig-linux-aarch64-0.13.0.tar.xz',
      topLevelDirectory: 'zig-linux-aarch64-0.13.0',
      sha256: '041ac42323837eb5624068acd8b00cd5777dac4cf91179e8dad7a7e90dd0c556',
      size: 43090688,
      officialUrl: 'https://ziglang.org/download/0.13.0/zig-linux-aarch64-0.13.0.tar.xz'
    }
  }
};

const fallbackMirrors = [
  'https://pkg.hexops.org/zig',
  'https://zigmirror.hryx.net/zig',
  'https://zig.linus.dev/zig',
  'https://zig.squirl.dev',
  'https://zig.mirror.mschae23.de/zig',
  'https://ziglang.freetls.fastly.net',
  'https://zig.tilok.dev',
  'https://zig-mirror.tsimnet.eu/zig',
  'https://zig.karearl.com/zig',
  'https://pkg.earth/zig',
  'https://fs.liujiacai.net/zigbuilds',
  'https://zigmirror.com',
  'https://zig.chainsafe.dev',
  'https://zig.savalione.com'
];

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target || hostTarget();
  const release = releaseFor(options.version || defaultVersion, target);
  const installRoot = path.resolve(options.installDir || defaultInstallRoot());
  const installDir = path.join(installRoot, release.version, target);
  const zigDir = path.join(installDir, release.topLevelDirectory);
  const zigBin = path.join(zigDir, 'zig');

  if (!isExecutable(zigBin) || zigVersion(zigBin) !== release.version) {
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });
    const archivePath = await downloadRelease(release, installDir, options);
    extractArchive(archivePath, installDir);
  }

  assert.equal(isExecutable(zigBin), true, `zig binary missing after install: ${zigBin}`);
  const actualVersion = zigVersion(zigBin);
  assert.equal(actualVersion, release.version, `installed Zig ${actualVersion}, expected ${release.version}`);
  exportGitHubPath(zigDir);
  console.log(`Zig ${actualVersion} installed at ${zigBin}`);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--version') {
      options.version = requireValue(args, ++i, arg);
    } else if (arg === '--target') {
      options.target = requireValue(args, ++i, arg);
    } else if (arg === '--install-dir') {
      options.installDir = requireValue(args, ++i, arg);
    } else if (arg === '--mirror') {
      options.mirrors = options.mirrors || [];
      options.mirrors.push(requireValue(args, ++i, arg));
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(requireValue(args, ++i, arg));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function hostTarget() {
  if (process.platform !== 'linux') {
    throw new Error(`unsupported Zig installer platform: ${process.platform}`);
  }
  if (process.arch === 'x64') {
    return 'linux-x64';
  }
  if (process.arch === 'arm64') {
    return 'linux-arm64';
  }
  throw new Error(`unsupported Zig installer architecture: ${process.arch}`);
}

function releaseFor(version, target) {
  const versionReleases = releases[version];
  if (!versionReleases) {
    throw new Error(`unsupported Zig version: ${version}`);
  }
  const release = versionReleases[target];
  if (!release) {
    throw new Error(`unsupported Zig target ${target} for ${version}`);
  }
  return {
    ...release,
    version,
    target
  };
}

function defaultInstallRoot() {
  if (process.env.RUNNER_TEMP) {
    return path.join(process.env.RUNNER_TEMP, 'ferrings-zig');
  }
  return path.join(repoRoot, '.cache', 'zig');
}

async function downloadRelease(release, installDir, options = {}) {
  const archivePath = path.join(installDir, release.filename);
  const urls = candidateUrls(release, {
    mirrors: options.mirrors || fallbackMirrors,
    shuffle: options.mirrors ? false : true
  });
  const failures = [];

  for (const url of urls) {
    try {
      await downloadAndVerify(url, archivePath, release, {
        timeoutMs: options.timeoutMs || 120000
      });
      console.log(`Downloaded ${release.filename} from ${safeUrlLabel(url)}`);
      return archivePath;
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      failures.push(`${safeUrlLabel(url)}: ${error.message}`);
      console.warn(`Zig download failed from ${safeUrlLabel(url)}: ${error.message}`);
    }
  }

  throw new Error(`failed to download ${release.filename}\n${failures.join('\n')}`);
}

function candidateUrls(release, { mirrors = fallbackMirrors, shuffle = true } = {}) {
  const orderedMirrors = shuffle ? shuffled(mirrors) : mirrors.slice();
  const urls = orderedMirrors.map((mirror) => {
    const base = mirror.replace(/\/+$/, '');
    return `${base}/${release.filename}?source=${encodeURIComponent(sourceName)}`;
  });
  urls.push(release.officialUrl);
  return urls;
}

function shuffled(values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function downloadAndVerify(url, archivePath, release, { timeoutMs }) {
  const tempPath = `${archivePath}.tmp-${process.pid}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const file = fs.createWriteStream(tempPath, { flags: 'wx' });
    const cleanup = () => {
      file.destroy();
      fs.rmSync(tempPath, { force: true });
    };

    file.on('error', (error) => {
      cleanup();
      reject(error);
    });

    requestToFile(url, file, {
      timeoutMs,
      onChunk(chunk) {
        bytes += chunk.length;
        if (bytes > release.size) {
          throw new Error(`download exceeded expected size ${release.size}`);
        }
        hash.update(chunk);
      }
    })
      .then(() => {
        if (bytes !== release.size) {
          throw new Error(`downloaded ${bytes} bytes, expected ${release.size}`);
        }
        const actualHash = hash.digest('hex');
        if (actualHash !== release.sha256) {
          throw new Error(`sha256 mismatch: ${actualHash}`);
        }
        fs.renameSync(tempPath, archivePath);
        resolve();
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

function requestToFile(url, file, { timeoutMs, onChunk }, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error(`too many redirects for ${url}`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          done(new Error(`redirect without location for ${url}`));
          return;
        }
        requestToFile(new URL(location, url).toString(), file, { timeoutMs, onChunk }, redirects + 1)
          .then(() => done())
          .catch(done);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        done(new Error(`HTTP ${status}`));
        return;
      }
      response.on('data', (chunk) => {
        try {
          onChunk(chunk);
          if (!file.write(chunk)) {
            response.pause();
            file.once('drain', () => response.resume());
          }
        } catch (error) {
          request.destroy(error);
        }
      });
      response.on('end', () => {
        file.end(() => done());
      });
      response.on('error', done);
    });
    request.on('error', done);
  });
}

function extractArchive(archivePath, installDir) {
  const result = spawnSync('tar', ['-xJf', archivePath, '-C', installDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar exited ${result.status}: ${result.stderr || result.stdout}`);
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function zigVersion(zigBin) {
  const result = spawnSync(zigBin, ['version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

function exportGitHubPath(zigDir) {
  if (process.env.GITHUB_PATH) {
    fs.appendFileSync(process.env.GITHUB_PATH, `${zigDir}\n`);
  }
}

function safeUrlLabel(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

module.exports = {
  candidateUrls,
  fallbackMirrors,
  hostTarget,
  releaseFor,
  releases,
  sourceName
};
