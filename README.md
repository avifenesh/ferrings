# ferrings

[![CI](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml)
[![Release](https://github.com/avifenesh/ferrings/actions/workflows/release.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/ferrings)](https://www.npmjs.com/package/ferrings)
![Node.js 22/24/26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

`ferrings` is a ready-to-use Linux `io_uring` TCP transport for Node.js services: a typed CommonJS/ESM package with Linux `x64`/`arm64` native binaries and a familiar TCP facade over a Rust/NAPI worker.

Use it when the built-in Node socket path is spending too much time on accept/recv/send syscalls under high connection churn, byte-moving TCP services, simple request/response traffic, or fixed-response health endpoints. The default fast path is multishot accept/recv plus provided buffer rings on supported Linux hosts. ZCRX is an optional receive path for hosts that pass the kernel, NIC, queue, permission, and routing checks.

Install from npm: `npm install ferrings`

## Benchmarks

Current package result: `ferrings@0.2.38` reached **2.15x** Node `http` throughput, **2.37x** Node `net` throughput on the native TCP path, **1.93x** throughput through the Node-style TCP facade, and **37-53% fewer server syscalls per completed connection** on the same host.

Measured on 2026-06-29 with `ferrings@0.2.38`, Node `v26.4.0`, npm `11.17.0`, Rust `1.96.0`, Linux `7.0.0-27-generic`, Intel Core Ultra 9 275HX, loopback traffic, `strace -f -c`, and an 8 MiB locked-memory limit. Absolute numbers are machine-specific; rerun this on the machine class you plan to deploy.

| Workload | Baseline | ferrings path | Baseline req/s | ferrings req/s | Result |
| --- | --- | --- | ---: | ---: | --- |
| Fixed-response HTTP | Node `http` | `UringHttpServer` | 4,407 | 9,462 | **2.15x throughput**, **47% lower p50**, **55% lower p99**, **52% fewer syscalls/conn** |
| TCP echo | Node `net` | native echo worker | 6,508 | 15,447 | **2.37x throughput**, **66% lower p50**, **16% lower p99**, **53% fewer syscalls/conn** |
| TCP echo | Node `net` | Node-style TCP facade | 6,508 | 12,554 | **1.93x throughput**, **57% lower p50**, **22% lower p99**, **37% fewer syscalls/conn** |
| TCP echo | Node `net` | facade batch send | 6,508 | 13,789 | **2.12x throughput**, **51% lower p50**, **48% lower p99**, **37% fewer syscalls/conn** |

Detailed latency and syscall data from the same run:

| Case | req/s | p50 ms | p95 ms | p99 ms | server syscalls/conn | Transport path |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Node `http` | 4,407 | 10.762 | 44.042 | 51.689 | 11.716 | libuv/epoll |
| ferrings HTTP | 9,462 | 5.743 | 19.516 | 23.370 | 5.599 | `io_uring` accept/recv + provided buffers |
| Node `net` TCP echo | 6,508 | 8.552 | 20.545 | 24.980 | 11.012 | libuv/epoll |
| ferrings native TCP echo | 15,447 | 2.904 | 19.024 | 20.867 | 5.155 | native echo worker + provided buffers |
| ferrings TCP facade | 12,554 | 3.677 | 17.907 | 19.608 | 6.899 | Node-style JS facade + batched native events |
| ferrings TCP facade batch send | 13,789 | 4.151 | 11.020 | 12.978 | 6.981 | JS facade + batched native events/sends |

The ferrings server info for this run reported `multishotAccept: true`, `multishotRecv: true`, and `providedBufferRing: true`. ZCRX stayed disabled (`zeroCopyReceive: false`), so these are default-path numbers from a normal supported Linux host.

Reproduce the README run:

```bash
REQUESTS=1000 CONCURRENCY=64 QUEUE_DEPTH=64 BUFFER_COUNT=512 BUFFER_SIZE=2048 \
CASES=node-http,ferrings-http,node-tcp,ferrings-native-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch \
REPORT_PATH=artifacts/benchmark-readme-node26-2026-06-29-0.2.38.json \
npm run bench:syscalls
```

Watch both throughput and server syscalls per completed connection. Tail latency depends on API surface, payload size, kernel, NIC path, CPU governor, queue settings, and the work you do in JavaScript callbacks.

## Installation

```bash
npm install ferrings
```

CommonJS and ESM named imports are both supported:

```js
const { createTcpServer } = require('ferrings');
// or
import { createTcpServer } from 'ferrings';
```

## Quick Start

Create `quickstart.js`:

```js
'use strict';

const net = require('node:net');
const { createTcpServer } = require('ferrings');

const server = createTcpServer(
  {
    host: '127.0.0.1',
    port: 0,
    backlog: 1024,
    useRecvBundle: true,
    useZeroCopySend: true
  },
  (connection) => {
    connection.on('data', (data) => {
      connection.end(Buffer.concat([Buffer.from('echo:'), data]));
    });
  }
);

server.listen((info) => {
  const client = net.createConnection({ host: info.host, port: info.port }, () => {
    client.write('hello');
  });

  let body = Buffer.alloc(0);
  client.on('data', (chunk) => {
    body = Buffer.concat([body, chunk]);
  });
  client.on('end', () => {
    console.log(body.toString('utf8'));
    server.close();
  });
});
```

Run it:

```bash
node quickstart.js
```

It prints `echo:hello`. Your application stays in ordinary JavaScript callbacks while ferrings handles accept, receive, send, shutdown, and buffer management on the native worker.

## Use Cases

- Use ferrings when a Linux Node service is limited by TCP syscall count, socket-path overhead, or high connection churn.
- Use the Node-style TCP facade when you want familiar `connection` and `data` callbacks over a native `io_uring` transport.
- Use raw or batched TCP events when callback/object overhead matters and your service can work directly with connection IDs.
- Use `UringHttpServer` for fixed health, readiness, or simple edge responses where an HTTP framework is unnecessary.
- Use ZCRX only on hosts where the kernel, NIC, queue setup, permissions, and traffic route pass the readiness checks.

## Supported Targets

Supported runtime targets:

- Linux
- Node.js 22, 24, or 26
- `x64` or `arm64`
- glibc or musl

CI tests Node 22, 24, and 26 on Linux. Per the [Node.js release schedule](https://nodejs.org/en/about/previous-releases), Node 26 is Current, Node 24 and 22 are LTS, and Node 20 is EOL. Node 20, 23, and 25 are EOL and not supported.

For local development, the repository pins Node 26 through `.nvmrc` and `.node-version`.

The root package installs the matching optional native package for the current Linux target:

- `ferrings-linux-x64-gnu`
- `ferrings-linux-x64-musl`
- `ferrings-linux-arm64-gnu`
- `ferrings-linux-arm64-musl`

The root package ships JavaScript, TypeScript declarations, docs, examples, and benchmarks. Native binaries live in the platform packages above, so the loader path is the same on every supported target.

If the native binding cannot be loaded, ferrings throws `FerringsNativeLoadError` with code `FERRINGS_NATIVE_LOAD_FAILED`, the detected platform target, supported native package names, the original loader error, and a structured `loadErrors` list with the generated NAPI loader attempts.

The CLI keeps version/help diagnostics available without a native binding. When optional native dependencies are missing, `ferrings doctor --json` reports `verdict: "native-load-blocked"` with a `nativeLoadError` object and loader-attempt details instead of failing before it can explain the install problem.

## Mental Model

The normal ferrings path is the broadly useful path:

- a normal Linux listening socket
- `io_uring` accept, recv, and send on a native worker
- multishot accept and multishot recv to reduce resubmission overhead
- provided receive buffers for explicit receive-buffer ownership
- bounded NAPI callbacks from native events into JavaScript
- bounded JavaScript-to-native command queues for writes and shutdown

ZCRX is not required to use ferrings. It is an extra receive path for capable hardware, and ferrings exposes probes and counters so you can gate it per host.

## API Choices

### Node-Style TCP

```js
const { createTcpServer } = require('ferrings');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => connection.end(data));
});

server.listen(0, '127.0.0.1', (info) => {
  console.log(info);
});
```

Use this for the most familiar server shape. The facade exposes `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.

### Raw TCP Events

```js
const { UringTcpServer } = require('ferrings');

const server = new UringTcpServer({
  host: '127.0.0.1',
  port: 0,
  useRecvBundle: true,
  useZeroCopySend: true
});

const info = server.start((event) => {
  if (event.eventType === 'data') {
    server.sendAndClose(event.connectionId, Buffer.from('pong'));
  }
});

console.log(`tcp://${info.host}:${info.port}`);
```

Use this when direct event objects and explicit connection IDs fit your service better than per-connection JavaScript objects.

### Batched TCP Events And Sends

```js
const { UringTcpServer } = require('ferrings');

const server = new UringTcpServer({ host: '127.0.0.1', port: 0 });

const info = server.startBatch((events) => {
  const sends = [];
  for (const event of events) {
    if (event.eventType === 'data') {
      sends.push({ connectionId: event.connectionId, data: event.data });
    }
  }
  if (sends.length > 0) {
    server.sendBatchAndClose(sends);
  }
});

console.log(`tcp://${info.host}:${info.port}`);
```

Use this for hot paths where native event batching is worth a less Node-like shape.

### Fixed-Response HTTP

```js
const { UringHttpServer } = require('ferrings');

const server = new UringHttpServer({
  host: '127.0.0.1',
  port: 0,
  responseBody: 'hello from ferrings\n',
  useZeroCopySend: true
});

const info = server.start();
console.log(`http://${info.host}:${info.port}`);
```

`UringHttpServer` is a fixed-response server for health-style responses and simple edge responses. It is not an HTTP application framework.

### Native TCP Echo

```js
const { UringTcpEchoServer } = require('ferrings');

const server = new UringTcpEchoServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopySend: true
});

const info = server.start();
console.log(`tcp://${info.host}:${info.port}`);
```

Use this to isolate the native TCP path from JavaScript event delivery when benchmarking or checking host behavior.

## Configuration

Common server options:

| Option | Default | Applies to | Purpose |
| --- | ---: | --- | --- |
| `host` | `127.0.0.1` | all servers | Bind address. |
| `port` | `0` | all servers | Bind port; `0` asks the kernel for a free port. |
| `backlog` | `1024` | all servers | Passed to `listen(2)`, subject to host `somaxconn`. |
| `queueDepth` | `64` | all servers | `io_uring` queue depth. |
| `bufferCount` | `512` | all servers | Receive buffer slots. |
| `bufferSize` | `2048` | all servers | Size of each receive buffer. |
| `maxConnections` | `0` | all servers | `0` means unlimited tracked active connections. |
| `idleTimeoutMs` | `0` | all servers | `0` disables native idle eviction. |
| `tcpNoDelay` | `true` | all servers | Applies `TCP_NODELAY` to accepted sockets. |
| `reusePort` | `false` | all servers | Applies `SO_REUSEPORT` before bind. |
| `tcpDeferAcceptSeconds` | `0` | all servers | Applies `TCP_DEFER_ACCEPT` when positive. |
| `socketRecvBufferSize` | `0` | all servers | `SO_RCVBUF`; `0` keeps kernel defaults. |
| `socketSendBufferSize` | `0` | all servers | `SO_SNDBUF`; `0` keeps kernel defaults. |
| `useRecvBundle` | `false` | TCP servers | Requests recv-bundle mode when supported. |
| `useZeroCopySend` | `false` | all servers | Requests `IORING_OP_SEND_ZC`. |
| `useRegisteredSendBuffer` | `false` | all servers | Requests fixed-buffer send mode. |
| `useZeroCopyReceive` | `false` | all servers | Requests ZCRX; requires capable hardware and permissions. |

TCP queue options:

| Option | Default | Purpose |
| --- | ---: | --- |
| `commandQueueCapacity` | `65536` | JS-to-native command queue bound. |
| `eventQueueCapacity` | `65536` | Native-to-JS event queue bound. |
| `eventBatchSize` | `64` | Events per JS batch in `startBatch()` and the facade. |
| `sendQueueCapacity` | `1024` | Per-connection native send backlog. |
| `sendBufferCount` | `256` | Fixed-send pool slot count. |
| `sendBufferSize` | `2048` | Fixed-send pool slot size. |

## Capabilities And Doctor

```js
const { capabilities, zcrxProbe } = require('ferrings');

console.log(capabilities());
console.log(zcrxProbe({
  interfaceName: 'eth0',
  rxQueue: 0,
  activeRegistration: true
}));
```

The installed CLI exposes the same checks:

```bash
npx ferrings --version
npx ferrings capabilities --json
npx ferrings doctor --require-ready --json
npx ferrings doctor --interface eth0 --rx-queue 0 --active --json
npx ferrings doctor --interface eth0 --rx-queue 0 --active --require-zcrx --require-ready --json
npx ferrings zcrx-probe --interface eth0 --rx-queue 0 --active --json
```

`capabilities()` reports kernel and `io_uring` fast-path availability, including multishot accept/recv, provided buffer rings, recv-bundle, zero-copy send, registered-buffer send, ZCRX opcode support, CQE32 ring setup, and fast poll.

`doctor` treats the default multishot/provided-buffer transport as the normal readiness path. Its top-level `ready` and `defaultReady` fields can be true while `zcrx.ready` is false; in that case ZCRX blockers are reported under `optionalBlockers`. Add `--require-zcrx --require-ready` when zero-copy receive must be a hard deployment gate.

## ZCRX

ZCRX is implemented as a gated receive path for hosts with the right kernel, permissions, NIC support, header/data split, RX queue setup, and flow steering or RSS isolation. Most deployments should start with the normal multishot/provided-buffer path and enable ZCRX only after the probe and hardware smoke test pass.

```bash
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

The ZCRX gate checks the running kernel release against known upstream ZCRX security advisory ranges, including CVE-2026-43121, CVE-2026-43174, CVE-2026-43224, and CVE-2026-45995. A matching kernel makes ZCRX not-ready and blocks `useZeroCopyReceive` startup before IFQ registration. If a distro kernel has the fix backported while retaining an affected-looking release string, set `FERRINGS_ZCRX_ALLOW_KERNEL_SECURITY_RISK=1` only after verifying the vendor patch level.

`test:zcrx` starts the HTTP, native TCP echo, and programmable TCP servers with `useZeroCopyReceive: true`, drives traffic through `ZCRX_CONNECT_HOST`, and requires `ServerInfo.zcrxPackets` and `zcrxBytes` to increase.

For real NIC receive validation, `ZCRX_CONNECT_HOST` must be a concrete non-loopback host routed through the selected NIC queue. Do not use `127.0.0.1`, `localhost`, `0.0.0.0`, or `::` for that check.

## Run Your Own Benchmarks

Benchmark entrypoints:

```bash
npm run bench
npm run bench:quick
npm run bench:tcp
npm run bench:high
REQUESTS=1000 CONCURRENCY=32 npm run bench:syscalls
```

Benchmark scripts:

- [`benchmark/compare.js`](benchmark/compare.js) compares Node HTTP with `UringHttpServer`.
- `npm run bench:quick` runs a compact HTTP, TCP, and syscall benchmark bundle.
- [`benchmark/tcp-echo.js`](benchmark/tcp-echo.js) compares Node TCP, the ferrings TCP facade, raw TCP, native echo, recv-bundle, and zero-copy-send variants when available.
- [`benchmark/high-concurrency.js`](benchmark/high-concurrency.js) runs HTTP and TCP cases with higher concurrency defaults.
- [`benchmark/syscalls.js`](benchmark/syscalls.js) uses `strace -f -c` when installed to report server-side syscalls per completed connection.

Set `REPORT_PATH=artifacts/<name>.json` to keep machine-readable reports. Useful knobs include `DURATION_MS`, `REQUESTS`, `CONCURRENCY`, `QUEUE_DEPTH`, `BUFFER_COUNT`, `BUFFER_SIZE`, `CASES`, and `SYSCALL_CASES`. If you raise `BUFFER_COUNT`, `QUEUE_DEPTH`, or fixed send-buffer counts, raise `ulimit -l` / `RLIMIT_MEMLOCK` too.

## Packages

Published packages:

- [`ferrings`](https://www.npmjs.com/package/ferrings)
- [`ferrings-linux-x64-gnu`](https://www.npmjs.com/package/ferrings-linux-x64-gnu)
- [`ferrings-linux-x64-musl`](https://www.npmjs.com/package/ferrings-linux-x64-musl)
- [`ferrings-linux-arm64-gnu`](https://www.npmjs.com/package/ferrings-linux-arm64-gnu)
- [`ferrings-linux-arm64-musl`](https://www.npmjs.com/package/ferrings-linux-arm64-musl)

Source development:

```bash
git clone https://github.com/avifenesh/ferrings.git
cd ferrings
npm install
npm test
```

## Project Health

- npm package: [`ferrings`](https://www.npmjs.com/package/ferrings)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Production runbook: [`docs/production.md`](docs/production.md)
- Examples: [`examples/http-fixed.js`](examples/http-fixed.js), [`examples/tcp-echo.js`](examples/tcp-echo.js)
- Benchmarks: [`benchmark/`](benchmark/)
- Type surface: [`index.d.ts`](index.d.ts), [`native.d.ts`](native.d.ts), [`tcp-transport.d.ts`](tcp-transport.d.ts)
- CLI entrypoint: [`bin/ferrings.js`](bin/ferrings.js)
- CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- Release workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- Security workflow: [`.github/workflows/security.yml`](.github/workflows/security.yml)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

There is no separate docs site yet; the README, production runbook, type definitions, examples, benchmarks, and tests are the current reference material.

## Release Checks

Useful checks before cutting a release:

```bash
npm run check:main-health
npm run check:workflows
npm run check:lockfile
npm run check:native-packages
npm run check:npm-names
npm run check:release-repository
npm run check:release-ready -- --full --strict
npm run check:release-ready -- --full --require-zcrx
npm run check:registry-install -- --version "$(node -p "require('./package.json').version")" --retries 12 --retry-delay-ms 5000
```

`check:release-ready -- --require-zcrx` requires `ZCRX_INTERFACE` and a non-loopback `ZCRX_CONNECT_HOST`, then runs `npm run test:zcrx`. Use this only on hardware where traffic can be routed through the selected NIC queue.

For host-level deployment checks, use `npx ferrings doctor --require-ready --json` for the default transport and add `--require-zcrx` only on hosts where ZCRX receive is required.

Tag pushes that match the package version build all native artifacts, run package checks, publish to npm with the repository `NPM_TOKEN` secret, verify the published root package, native packages, integrity metadata, provenance attestations, registry signatures, and dist-tag from the npm registry, and then create or update the GitHub release. Manual `workflow_dispatch` runs can also publish when `publish=true`.

Release reruns are registry-aware: if the exact version is already published and passes `check:published`, the workflow skips native rebuilds and the immutable `npm publish` call, then keeps the registry verification and install-smoke steps.

After a release has propagated, this should pass:

```bash
npm run check:published -- --tag latest --verify-tarballs
npm run check:main-health
```

`check:published --verify-tarballs` verifies registry metadata, provenance, signatures, dist-tags, and downloaded npm tarball contents for the root package and every native package. `check:registry-install` accepts `--retries` and `--retry-delay-ms` for the short post-publish window where the root package can become visible before every optional native package resolves consistently from all npm caches.

For a new release, bump the package version first; npm versions are immutable after publication, so `check:release-ready` is a release gate rather than a normal post-release main-branch check. Use `check:main-health` when validating current `main` after a release or docs/tooling follow-up.

## Limitations

- Linux only; there is no macOS or Windows transport.
- Node.js 22, 24, or 26 is required. Node 20, 23, and 25 are EOL and not supported.
- This is a native addon, so kernel support and process limits affect which fast paths are active.
- The TCP facade follows the common Node server shape, but it is not a drop-in replacement for every `net.Server` behavior.
- `UringHttpServer` is a fixed-response server, not an HTTP application framework.
- TLS is not implemented.
- ZCRX requires specific NIC hardware, kernel support, queue setup, permissions, and routed traffic through the selected RX queue.
- Registered-buffer send can be unavailable even when the kernel supports other modern `io_uring` networking features; ferrings reports that through `capabilities().registeredSendBuffer`.
- ferrings is in the `0.x` version line: patch releases are intended to be safe updates, while minor releases may adjust API names or defaults.

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md).

Run this baseline before opening a change:

```bash
npm install
npm test
npm run audit:deps
npm run check:pack
```

For changes that touch native packaging, also run:

```bash
npm run check:native-packages
npm run check:pack
```

For type-surface changes, `npm test` runs `npm run test:types`, which compiles a consumer TypeScript smoke test against the published `.d.ts` entrypoints.

For ZCRX changes, include `npm run test:zcrx` output when you have access to capable hardware. If you do not, include `node bin/ferrings.js zcrx-probe --all --active --json` output so reviewers can see the blocker.

## License

Licensed under either of:

- [MIT](LICENSE-MIT)
- [Apache-2.0](LICENSE-APACHE)

at your option.
