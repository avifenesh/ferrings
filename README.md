# ferrings

[![CI](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml)
[![Release](https://github.com/avifenesh/ferrings/actions/workflows/release.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/ferrings)](https://www.npmjs.com/package/ferrings)
![Node.js 22/24/26](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-339933)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

Usable Linux `io_uring` TCP transport for Node.js services, built in Rust with napi-rs and exposed through a familiar Node-style server API.

ferrings gives Node applications a native TCP path outside libuv's epoll networking loop. It owns the listening socket, drives accept/recv/send from a Rust `io_uring` worker, and ships as one npm package with per-platform native packages resolved by npm.

## Performance

The benchmark scripts ship in this repo and in the npm package. This run was measured on 2026-06-28 on an Intel Core Ultra 9 275HX laptop, Linux `7.0.0-22-generic`, Node `v26.4.0`, npm `11.17.0`, Rust `1.96.0`, and the default 8 MiB locked-memory limit. It is a loopback benchmark under `strace -f -c`; absolute numbers are machine-specific, but the same-host comparison is the point.

| Case | req/s | p99 ms | server syscalls/conn | Path |
| --- | ---: | ---: | ---: | --- |
| Node `http` | 2,673 | 67.245 | 11.781 | libuv/epoll |
| ferrings HTTP | 4,118 | 40.127 | 6.181 | `io_uring` accept/recv + provided buffer ring |
| Node `net` TCP echo | 3,650 | 26.580 | 11.075 | libuv/epoll |
| ferrings native TCP echo | 8,277 | 22.718 | 5.140 | native echo worker + provided buffer ring |
| ferrings TCP facade | 7,565 | 24.311 | 6.935 | Node-style JS facade + batched native events |
| ferrings TCP facade batch send | 6,694 | 25.849 | 6.890 | JS facade + batched native events/sends |

In this run, ferrings HTTP delivered 1.54x Node HTTP throughput with 48% fewer server syscalls per completed connection. The native TCP echo path delivered 2.27x Node `net` throughput with 54% fewer server syscalls. The Node-style TCP facade still crosses into JavaScript, but it stayed ahead of the Node baseline while keeping the application API ergonomic.

## Install

```bash
npm install ferrings
```

Requirements:

- Linux
- Node.js `>=22`
- A target supported by the published native packages: `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, or `linux-arm64-musl`

CI currently tests Node 22, 24, and 26 on Linux.

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

It prints `echo:hello`. Your application handles normal JavaScript callbacks; ferrings handles the listening socket, multishot receive path, sends, and shutdown on the native worker.

## Why Use It

- Use ferrings when you want a real Node TCP server API backed by Linux `io_uring` instead of libuv's epoll networking path.
- Use ferrings when syscall count, tail latency, and high connection concurrency matter enough to justify a Linux native dependency.
- Use ferrings when you want runtime counters for multishot accept/recv, provided buffer rings, recv-bundle, zero-copy send, registered-buffer send probes, and ZCRX readiness.
- Use ferrings when you want Rust-native networking work while keeping application code, callbacks, packaging, and deployment in Node.js.
- Use ferrings when you are preparing for ZCRX-capable NICs but need the broadly useful multishot/provided-buffer path to work on ordinary recent kernels.

## Core Model

ferrings is not a wrapper around Node's `net.Server`. It creates the listening socket directly with `socket`, `bind`, and `listen`, then drives accepts, receives, sends, and shutdown from a Rust worker thread with `io_uring`.

JavaScript still owns the application surface:

- Native-to-JS events are delivered through NAPI thread-safe callbacks.
- JS-to-native writes go through a bounded command queue and an `eventfd` wakeup.
- The Node-style facade exposes `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.
- Lower-level APIs expose connection IDs, batched events, batched sends, server counters, and active capability probes.

The default receive path is multishot accept + multishot recv + provided buffers. ZCRX is separate and explicitly gated because it needs kernel support, NIC header/data split, RX queue setup, flow steering or RSS isolation, and permissions.

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

`UringHttpServer` is for fixed-response endpoints and transport measurements. It is not an HTTP framework.

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

## Reproduce The Benchmarks

Run the README table:

```bash
REQUESTS=1000 CONCURRENCY=64 QUEUE_DEPTH=64 BUFFER_COUNT=512 BUFFER_SIZE=2048 \
CASES=node-http,ferrings-http,node-tcp,ferrings-native-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch \
REPORT_PATH=artifacts/benchmark-readme-node26-2026-06-28.json \
npm run bench:syscalls
```

Full table from that run:

| Case | req/s | p50 ms | p95 ms | p99 ms | server syscalls/conn | Path |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Node `http` | 2,673 | 19.886 | 55.742 | 67.245 | 11.781 | libuv/epoll |
| ferrings HTTP | 4,118 | 12.891 | 31.286 | 40.127 | 6.181 | `io_uring` accept/recv + provided buffer ring |
| Node `net` TCP echo | 3,650 | 16.051 | 24.966 | 26.580 | 11.075 | libuv/epoll |
| ferrings native TCP echo | 8,277 | 6.408 | 18.805 | 22.718 | 5.140 | native echo worker + provided buffer ring |
| ferrings TCP facade | 7,565 | 7.366 | 22.139 | 24.311 | 6.935 | JS facade + batched native events |
| ferrings TCP facade batch send | 6,694 | 8.626 | 21.719 | 25.849 | 6.890 | JS facade + batched native events/sends |

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

## Packages

The root package is Linux-only and depends on target-specific optional native packages. A normal install picks the one package that matches the current machine.

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

## Project Health

- npm package: [`ferrings`](https://www.npmjs.com/package/ferrings)
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
npm run check:native-packages
npm run check:npm-names
npm run check:release-repository
npm run check:release-ready -- --full --strict
npm run check:release-ready -- --full --require-zcrx
```

Tag pushes that match the package version build all native artifacts, run package checks, and publish to npm with the repository `NPM_TOKEN` secret. Manual `workflow_dispatch` runs can also publish when `publish=true`. For a new release, bump the package version first; npm versions are immutable after publication, so `check:release-ready` is a release gate rather than a normal post-release main-branch check.

## Limitations

- Linux only; there is no macOS or Windows transport.
- Node.js `>=22` is required.
- This is a native addon, so kernel support and process limits affect which fast paths are active.
- The TCP facade follows the common Node server shape, but it is not a drop-in replacement for every `net.Server` behavior.
- `UringHttpServer` is a fixed-response server, not an HTTP application framework.
- TLS is not implemented.
- ZCRX requires specific NIC hardware, kernel support, queue setup, permissions, and routed traffic through the selected RX queue.
- Registered-buffer send can be unavailable even when the kernel supports other modern `io_uring` networking features; ferrings reports that through `capabilities().registeredSendBuffer`.
- This is a `0.x` package; API names and defaults may change between minor releases.

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
