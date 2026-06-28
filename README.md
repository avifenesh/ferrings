# ferrings

[![CI](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml)
[![Release](https://github.com/avifenesh/ferrings/actions/workflows/release.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/ferrings)](https://www.npmjs.com/package/ferrings)
![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-339933)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

Linux `io_uring` TCP transport for Node.js services, built with Rust and napi-rs.

ferrings gives Node applications a native Linux TCP path outside libuv's networking loop: multishot accept/recv, provided buffer rings, recv-bundle, zero-copy send, registered-buffer send probes, and an optional ZCRX fast path for capable NICs. It installs as one npm package; npm resolves the matching native binding for your Linux target.

```bash
npm install ferrings
```

## Benchmark Snapshot

Measured on 2026-06-28 on an Intel Core Ultra 9 275HX laptop, Linux `7.0.0-22-generic`, Node `v25.9.0`, npm `11.12.1`, Rust `1.96.0`, with the default 8 MiB locked-memory limit. This is loopback under `strace -f -c`, not a NIC or ZCRX benchmark, so use the ratios more than the absolute numbers.

| Case | req/s | p99 ms | server syscalls/conn | Fast path |
| --- | ---: | ---: | ---: | --- |
| Node `http` | 2,689 | 75.987 | 11.620 | libuv/epoll |
| ferrings HTTP | 5,547 | 33.123 | 5.645 | multishot accept/recv + provided buffer ring |
| Node `net` TCP echo | 4,086 | 26.649 | 10.987 | libuv/epoll |
| ferrings native TCP echo | 8,128 | 20.422 | 5.842 | native echo worker + provided buffer ring |
| ferrings TCP facade batch send | 8,451 | 28.451 | 7.143 | JS facade + batched native events/sends |

In this snapshot, ferrings roughly halves server syscalls per completed connection and about doubles throughput versus stock Node `http` / `net` servers on the same machine. The Node-style TCP facade still crosses into JavaScript, but batching keeps it ahead of the baseline in this workload.

## Quick Start

Create `quickstart.js`:

```js
'use strict';

const net = require('node:net');
const { createTcpServer } = require('ferrings');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => {
    connection.end(Buffer.concat([Buffer.from('echo:'), data]));
  });
});

server.listen(
  {
    host: '127.0.0.1',
    port: 0,
    backlog: 1024,
    useRecvBundle: true,
    useZeroCopySend: true
  },
  (info) => {
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
  }
);
```

Run it:

```bash
node quickstart.js
```

It prints `echo:hello`. `createTcpServer()` exposes a familiar Node-style TCP server while the accept, receive, send, and shutdown work run on a Rust `io_uring` worker.

## Quick Proof Signals

- Published on npm as [`ferrings`](https://www.npmjs.com/package/ferrings) for Linux Node.js `>=22`.
- CI builds and tests Node 22, 24, and 26 on Linux.
- Release CI builds four native packages: `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, and `linux-arm64-musl`.
- Package install smoke tests install the packed tarball in a temporary app, start a TCP server through `require('ferrings')`, and run the installed CLI.
- `npm run check:release-ready -- --full --strict` verifies package metadata, npm version availability, install smoke tests, dry-run publish checks, GitHub repository metadata, and the `NPM_TOKEN` secret.

## When To Use It

- Use ferrings when you want a real Node TCP server API backed by Linux `io_uring` instead of libuv's epoll networking path.
- Use ferrings when syscall count, tail latency, and connection concurrency matter enough to justify a Linux-only native dependency.
- Use ferrings when you want runtime visibility into multishot recv, provided buffer rings, recv-bundle, zero-copy send, registered-buffer send, and ZCRX readiness.
- Use ferrings when you need a Rust-native networking worker but still want application code, callbacks, and deployment to stay in Node.js.
- Use ferrings when you are preparing for ZCRX-capable NICs but need the broadly useful multishot/provided-buffer core to work on ordinary recent kernels.

## Mental Model

ferrings is not a wrapper around Node's `net.Server`. It creates the listening socket directly with `socket`, `bind`, and `listen`, then drives accepts, receives, sends, and shutdown from a Rust worker thread with `io_uring`.

JavaScript still owns the application surface:

- Native-to-JS events are delivered through NAPI thread-safe callbacks.
- JS-to-native writes go through a bounded command queue and an `eventfd` wakeup.
- The Node-style facade exposes `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.
- Lower-level APIs expose connection IDs, batched events, batched sends, server counters, and active capability probes.

The core receive path is multishot accept + multishot recv + provided buffers. ZCRX is separate and explicitly gated because it requires kernel support, NIC header/data split, RX queue setup, flow steering or RSS isolation, and permissions.

## APIs

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

Use this when you want a familiar server shape over the native transport.

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

`UringHttpServer` is useful for fixed-response servers and transport benchmarking. It is not a general HTTP framework.

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

### Capability And ZCRX Probes

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

The installed CLI exposes the same diagnostics:

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

TCP-only queue options:

| Option | Default | Purpose |
| --- | ---: | --- |
| `commandQueueCapacity` | `65536` | JS-to-native command queue bound. |
| `eventQueueCapacity` | `65536` | Native-to-JS event queue bound. |
| `eventBatchSize` | `64` | Events per JS batch in `startBatch()` and the facade. |
| `sendQueueCapacity` | `1024` | Per-connection native send backlog. |
| `sendBufferCount` | `256` | Fixed-send pool slot count. |
| `sendBufferSize` | `2048` | Fixed-send pool slot size. |

All servers expose live counters through `ServerInfo`, including accepted/closed/rejected connections, bytes sent/received, queue drops, receive buffer starvations, recv-bundle counters, zero-copy send counters, fixed-send misses, and ZCRX packet counters.

## Full Benchmark Details

Run the README snapshot:

```bash
REQUESTS=1000 CONCURRENCY=64 QUEUE_DEPTH=64 BUFFER_COUNT=512 BUFFER_SIZE=2048 \
CASES=node-http,ferrings-http,node-tcp,ferrings-native-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch \
REPORT_PATH=artifacts/benchmark-readme-2026-06-28.json \
npm run bench:syscalls
```

Full result table:

| Case | req/s | p50 ms | p95 ms | p99 ms | server syscalls/conn | Fast path |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Node `http` | 2,689 | 19.536 | 63.368 | 75.987 | 11.620 | libuv/epoll |
| ferrings HTTP | 5,547 | 10.480 | 28.965 | 33.123 | 5.645 | multishot accept/recv + provided buffer ring |
| Node `net` TCP echo | 4,086 | 14.881 | 19.244 | 26.649 | 10.987 | libuv/epoll |
| ferrings native TCP echo | 8,128 | 6.353 | 16.562 | 20.422 | 5.842 | native echo worker + provided buffer ring |
| ferrings TCP facade | 7,001 | 7.199 | 30.371 | 33.890 | 8.149 | JS facade + batched native events |
| ferrings TCP facade batch send | 8,451 | 6.188 | 24.787 | 28.451 | 7.143 | JS facade + batched native events/sends |

Other benchmark commands:

```bash
npm run bench
npm run bench:tcp
npm run bench:high
npm run bench:first-slice
REQUESTS=1000 CONCURRENCY=32 npm run bench:syscalls
```

Benchmark scripts:

- `benchmark/compare.js` compares Node HTTP with `UringHttpServer`.
- `benchmark/tcp-echo.js` compares Node TCP, the ferrings TCP facade, raw TCP, native echo, recv-bundle, and zero-copy-send variants when available.
- `benchmark/high-concurrency.js` runs HTTP and TCP cases with higher concurrency defaults.
- `benchmark/syscalls.js` uses `strace -f -c` when installed to report server-side syscalls per completed connection.
- `benchmark/first-slice.js` writes one compact validation report across capabilities, HTTP, TCP, and syscall cases.

Set `REPORT_PATH=artifacts/<name>.json` to keep machine-readable reports. Useful knobs include `DURATION_MS`, `REQUESTS`, `CONCURRENCY`, `QUEUE_DEPTH`, `BUFFER_COUNT`, `BUFFER_SIZE`, `CASES`, and `SYSCALL_CASES`. If you raise `BUFFER_COUNT`, `QUEUE_DEPTH`, or fixed send-buffer counts, raise `ulimit -l` / `RLIMIT_MEMLOCK` too.

## ZCRX

ZCRX support is present but gated. Use it only on hosts with the right kernel, permissions, NIC support, header/data split, and flow steering/RSS isolation.

```bash
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

`test:zcrx` starts the HTTP, native TCP echo, and programmable TCP servers with `useZeroCopyReceive: true`, drives traffic through `ZCRX_CONNECT_HOST`, and requires `ServerInfo.zcrxPackets` and `zcrxBytes` to increase.

For a real NIC receive proof, avoid `127.0.0.1`; route packets through the selected NIC queue, usually from a second host or a network namespace.

## Installation And Supported Targets

The base package is Linux-only and depends on target-specific optional native packages. A normal install picks the one package that matches the current machine.

Published packages:

- `ferrings`
- `ferrings-linux-x64-gnu`
- `ferrings-linux-x64-musl`
- `ferrings-linux-arm64-gnu`
- `ferrings-linux-arm64-musl`

Source development:

```bash
git clone https://github.com/avifenesh/ferrings.git
cd ferrings
npm install
npm test
```

## Release Checks

Useful checks before cutting a release:

```bash
npm run check:native-packages
npm run check:npm-names
npm run check:release-repository
npm run check:release-ready -- --full --strict
npm run check:release-ready -- --full --require-zcrx
```

Tag pushes that match the package version build all native artifacts, run package checks, and publish to npm with the repository `NPM_TOKEN` secret. Manual `workflow_dispatch` runs can also publish when `publish=true`. For a new release, bump the package version first; npm versions are immutable after publication, so `check:release-ready` is a release gate rather than a normal post-release main-branch check.

## Limitations And Tradeoffs

- Linux only; there is no macOS or Windows transport.
- Node.js `>=22` is required.
- This is a native addon, so kernel support and process limits affect which fast paths are active.
- The TCP facade intentionally follows the common Node server shape, but it is not a drop-in replacement for every `net.Server` behavior.
- `UringHttpServer` is a fixed-response server, not an HTTP application framework.
- TLS is not implemented.
- ZCRX requires specific NIC hardware, kernel support, queue setup, permissions, and routed traffic through the selected RX queue.
- Registered-buffer send can be unavailable even when the kernel supports other modern `io_uring` networking features; ferrings reports that through `capabilities().registeredSendBuffer`.
- APIs are still early and may change between 0.x releases.

## Project Health

- Examples: [`examples/http-fixed.js`](examples/http-fixed.js), [`examples/tcp-echo.js`](examples/tcp-echo.js)
- Benchmarks: [`benchmark/`](benchmark/)
- Type surface: [`index.d.ts`](index.d.ts), [`native.d.ts`](native.d.ts)
- CLI entrypoint: [`bin/ferrings.js`](bin/ferrings.js)
- Release workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- Security workflow: [`.github/workflows/security.yml`](.github/workflows/security.yml)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Tests: [`test/`](test/)

There is no separate docs site yet; the README, type definitions, examples, and tests are the current reference material.

## Contributing

Issues and pull requests are welcome. There is no standalone `CONTRIBUTING.md` yet, so use this baseline before opening a change:

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
