# ferrings

[![CI](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml)
[![Release](https://github.com/avifenesh/ferrings/actions/workflows/release.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/ferrings)](https://www.npmjs.com/package/ferrings)
![Node.js 22/24/26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

Linux `io_uring` TCP transport for Node.js services, built in Rust with napi-rs and published as native npm packages for x64/arm64 Linux.

ferrings gives Node services a real TCP server surface while moving accept, receive, send, and shutdown work out of libuv's epoll path and into a Rust `io_uring` worker. The default path already uses multishot accept/recv and provided receive buffers on ordinary recent Linux kernels; ZCRX is an optional hardware-gated receive path, not a requirement for the current gains.

## Benchmarks

Benchmarks are first because ferrings exists to reduce syscall pressure on busy Linux TCP servers. In the current Node 26 snapshot, the `io_uring` path delivered **1.99x** fixed-response HTTP throughput and **2.24x** native TCP echo throughput while cutting server syscalls per completed connection by roughly half.

| Workload | Baseline | ferrings path | Throughput | p99 latency | Server syscalls/conn |
| --- | --- | --- | ---: | ---: | ---: |
| Fixed-response HTTP | Node `http` | `UringHttpServer` | **1.99x** | **49% lower** | **56% fewer** |
| TCP echo | Node `net` | native echo worker | **2.24x** | 5% higher | **53% fewer** |
| TCP echo | Node `net` | Node-style TCP facade | **1.45x** | 51% higher | **38% fewer** |
| TCP echo | Node `net` | facade batch send | **1.83x** | **14% lower** | **38% fewer** |

Measured on 2026-06-29 with `ferrings@0.2.15`, Intel Core Ultra 9 275HX, Linux `7.0.0-27-generic`, Node `v26.4.0`, npm `11.17.0`, Rust `1.96.0`, loopback traffic, `strace -f -c`, and an 8 MiB locked-memory limit. Absolute numbers are machine-specific; the useful signal is the same-host comparison against Node's built-in transports.

Detailed results:

| Case | req/s | p50 ms | p95 ms | p99 ms | server syscalls/conn | Transport path |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Node `http` | 4,640 | 11.080 | 36.955 | 42.836 | 11.852 | libuv/epoll |
| ferrings HTTP | 9,215 | 4.966 | 18.270 | 21.875 | 5.274 | `io_uring` accept/recv + provided buffers |
| Node `net` TCP echo | 6,976 | 8.676 | 13.336 | 15.335 | 11.021 | libuv/epoll |
| ferrings native TCP echo | 15,596 | 3.239 | 14.279 | 16.034 | 5.220 | native echo worker + provided buffers |
| ferrings TCP facade | 10,101 | 4.222 | 21.462 | 23.198 | 6.882 | Node-style JS facade + batched native events |
| ferrings TCP facade batch send | 12,766 | 4.327 | 11.466 | 13.223 | 6.787 | JS facade + batched native events/sends |

Reproduce the table:

```bash
REQUESTS=1000 CONCURRENCY=64 QUEUE_DEPTH=64 BUFFER_COUNT=512 BUFFER_SIZE=2048 \
CASES=node-http,ferrings-http,node-tcp,ferrings-native-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch \
REPORT_PATH=artifacts/benchmark-readme-node26-2026-06-29-0.2.15.json \
npm run bench:syscalls
```

Run the benchmarks on the host class you plan to deploy. TCP tail latency depends on the selected API surface, payload shape, kernel, NIC path, and queue settings; the syscall-count delta is the part to watch when comparing against Node's built-in transports.

## Installation

```bash
npm install ferrings
```

Requirements:

- Linux
- Node.js `>=22`
- `x64` or `arm64`
- glibc or musl

CI tests Node 22, 24, and 26 on Linux. Per the [Node.js release schedule](https://nodejs.org/en/about/previous-releases), Node 26 is current, Node 24 and 22 are LTS, and Node 20 is EOL.

The root package installs the matching optional native package for the current Linux target:

- `ferrings-linux-x64-gnu`
- `ferrings-linux-x64-musl`
- `ferrings-linux-arm64-gnu`
- `ferrings-linux-arm64-musl`

If the native binding cannot be loaded, ferrings throws `FerringsNativeLoadError` with code `FERRINGS_NATIVE_LOAD_FAILED`, the detected platform target, the supported native package names, and the original loader error.

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

It prints `echo:hello`. Application code handles normal JavaScript callbacks; ferrings handles the socket lifecycle, multishot receive path, sends, and shutdown on the native worker.

## When To Use Ferrings

- Use ferrings when you run Linux Node services and TCP syscall count, tail latency, or high connection concurrency are part of the scaling problem.
- Use the Node-style TCP facade when you want familiar JavaScript callbacks over a native `io_uring` transport.
- Use raw or batched TCP events when callback overhead matters and your server can process connection IDs directly.
- Use `UringHttpServer` for fixed health, readiness, or simple edge responses where a full HTTP framework would be unnecessary.
- Use the ZCRX path only on hosts with the required kernel, NIC, queue, and routing setup; the normal multishot/provided-buffer path does not depend on it.

## What You Get

- A Node-style TCP server facade with `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.
- Raw and batched TCP event APIs for lower callback overhead.
- Multishot accept/recv with provided receive buffers on ordinary recent Linux kernels.
- Optional recv-bundle, zero-copy send, registered send-buffer, and ZCRX paths with capability reporting.
- A fixed-response HTTP server for health checks and simple edge-style responses.
- A native TCP echo server for isolating the native transport path.
- CLI and API probes for runtime capabilities, ZCRX readiness, and installed-package health.
- Native npm packages for x64/arm64 glibc/musl Linux targets.

The main deployment path is multishot accept/recv with provided buffers. ZCRX is an advanced hardware-gated receive path for capable NICs.

## How It Works

ferrings creates the listening socket directly with `socket`, `bind`, and `listen`, then drives accepts, receives, sends, and shutdown from a Rust worker thread with `io_uring`.

The default receive path uses multishot accept, multishot recv, and provided buffers. JavaScript still owns the application surface:

- Native-to-JS events are delivered through NAPI thread-safe callbacks.
- JS-to-native writes go through a bounded command queue and an `eventfd` wakeup.
- The Node-style facade exposes `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.
- Lower-level APIs expose connection IDs, batched events, batched sends, server counters, and active capability probes.

ZCRX is separate and explicitly gated because it needs kernel support, NIC header/data split, RX queue setup, flow steering or RSS isolation, and permissions.

## API

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

Use this for a familiar Node server shape over the native transport.

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

Use this when you want direct event objects and explicit connection IDs.

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

Use this when JS callback overhead matters and events can be processed in batches.

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

Use this to isolate the native TCP path from JavaScript event delivery.

## Capabilities And Doctor

```js
const { capabilities, zcrxProbe } = require('ferrings');

console.log(capabilities());
console.log(zcrxProbe({ interfaceName: 'eth0' }));
console.log(zcrxProbe({
  interfaceName: 'eth0',
  rxQueue: 0,
  activeRegistration: true
}));
```

The installed CLI exposes the same checks:

```bash
npx ferrings capabilities --json
npx ferrings doctor --interface eth0 --rx-queue 0 --active --json
npx ferrings zcrx-probe --interface eth0 --rx-queue 0 --active --json
```

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

All servers expose live counters through `ServerInfo`, including accepted/closed/rejected connections, bytes sent/received, queue drops, receive buffer starvations, recv-bundle counters, zero-copy send counters, fixed-send misses, and ZCRX packet counters.

## ZCRX

ZCRX support is implemented as a gated transport path for hosts with the right kernel, permissions, NIC support, header/data split, and flow steering/RSS isolation. Most deployments should start with the default multishot/provided-buffer receive path and enable ZCRX only after the probe and hardware smoke test pass.

```bash
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

`test:zcrx` starts the HTTP, native TCP echo, and programmable TCP servers with `useZeroCopyReceive: true`, drives traffic through `ZCRX_CONNECT_HOST`, and requires `ServerInfo.zcrxPackets` and `zcrxBytes` to increase.

For a real NIC receive validation, avoid `127.0.0.1`; route packets through the selected NIC queue, usually from a second host or a network namespace.

## Benchmarking

Other benchmark entrypoints:

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
- Contributing guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Examples: [`examples/http-fixed.js`](examples/http-fixed.js), [`examples/tcp-echo.js`](examples/tcp-echo.js)
- Benchmarks: [`benchmark/`](benchmark/)
- Type surface: [`index.d.ts`](index.d.ts), [`native.d.ts`](native.d.ts)
- CLI entrypoint: [`bin/ferrings.js`](bin/ferrings.js)
- CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- Release workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- Security workflow: [`.github/workflows/security.yml`](.github/workflows/security.yml)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Tests: [`test/`](test/)

There is no separate docs site yet; the README, type definitions, examples, benchmarks, and tests are the current reference material.

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
npm run check:registry-install -- --version "$(node -p "require('./package.json').version")"
```

`check:release-ready -- --require-zcrx` requires `ZCRX_INTERFACE` and a
non-loopback `ZCRX_CONNECT_HOST`, then runs `npm run test:zcrx`. Use this only
on hardware where traffic can be routed through the selected NIC queue.

Tag pushes that match the package version build all native artifacts, run package checks, publish to npm with the repository `NPM_TOKEN` secret, verify the published root package, native packages, integrity metadata, provenance attestations, registry signatures, and dist-tag from the npm registry, and then create or update the GitHub release. Manual `workflow_dispatch` runs can also publish when `publish=true`.

Release reruns are registry-aware: if the exact version is already published and passes `check:published`, the workflow skips the immutable `npm publish` call and keeps the registry verification step.

After a release has propagated, this should pass:

```bash
npm run check:published -- --tag latest --verify-tarballs
npm run check:main-health
```

`check:published --verify-tarballs` verifies registry metadata, provenance, signatures, dist-tags, and the downloaded npm tarball contents for the root package and every native package.

For a new release, bump the package version first; npm versions are immutable after publication, so `check:release-ready` is a release gate rather than a normal post-release main-branch check. Use `check:main-health` when validating current `main` after a release or docs/tooling follow-up.

## Limitations

- Linux only; there is no macOS or Windows transport.
- Node.js `>=22` is required. Node 20 is EOL and not supported.
- This is a native addon, so kernel support and process limits affect which fast paths are active.
- The TCP facade follows the common Node server shape, but it is not a drop-in replacement for every `net.Server` behavior.
- `UringHttpServer` is a fixed-response server, not an HTTP application framework.
- TLS is not implemented.
- ZCRX requires specific NIC hardware, kernel support, queue setup, permissions, and routed traffic through the selected RX queue.
- Registered-buffer send can be unavailable even when the kernel supports other modern `io_uring` networking features; ferrings reports that through `capabilities().registeredSendBuffer`.
- ferrings is a `0.x` package: patch releases are intended to be safe updates, while minor releases may still adjust API names or defaults as the public surface settles.

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md).
At minimum, run this baseline before opening a change:

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
