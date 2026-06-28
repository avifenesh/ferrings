# ferrings

[![CI](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/ci.yml)
[![Release](https://github.com/avifenesh/ferrings/actions/workflows/release.yml/badge.svg)](https://github.com/avifenesh/ferrings/actions/workflows/release.yml)
![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)

Linux `io_uring` TCP transport for Node.js, built with Rust and napi-rs for high-concurrency server experiments outside libuv's networking loop.

ferrings exposes Node-friendly TCP and fixed-response HTTP APIs backed by a native `io_uring` worker: multishot accept/recv, provided buffer rings, recv-bundle, zero-copy send, and an optional ZCRX path for capable NICs. The project is at the 0.1.0 source-release stage; npm publishing is intentionally still gated on trusted publishing setup.

```bash
git clone https://github.com/avifenesh/ferrings.git
cd ferrings
npm install
npm run build
```

```js
const net = require('node:net');
const { createTcpServer } = require('./');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => connection.end(`ferrings:${data}`));
});

server.listen(0, '127.0.0.1', (info) => {
  const client = net.createConnection(info.port, info.host, () => client.write('ping'));
  client.on('data', (data) => {
    console.log(data.toString());
    server.close();
  });
});
```

Run the example from the repository root with `node quickstart.js`; it prints `ferrings:ping`. After npm publishing, replace `require('./')` with `require('ferrings')`.

## Quick proof signals

- Linux-only native addon for Node.js `>=20`, written in Rust with napi-rs.
- CI builds and tests Node 20, 22, and 24 on Linux.
- Release workflow builds native packages for `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, and `linux-arm64-musl`.
- `npm run check:release-ready -- --full --strict` reports `ready-with-optional-blockers`; the optional blocker is ZCRX hardware proof.
- Package install smoke tests pack the tarball, install it in a temporary app, start a TCP server through `require('ferrings')`, and run the installed CLI.

## Why this project

- Use this when you want to compare Node's `net` / `http` servers with a modern Linux `io_uring` TCP path.
- Use this when you need a Node API over a Rust-native networking worker for high-concurrency Linux experiments.
- Use this when you want runtime visibility into kernel features such as multishot recv, provided buffer rings, recv-bundle, zero-copy send, and ZCRX readiness.
- Use this when you want to benchmark syscall counts, tail latency, and queue behavior without building a native addon from scratch.
- Use this when you are exploring ZCRX, but want the broadly usable core to work on machines without ZCRX-capable NIC hardware.

## Installation

The npm package family is prepared but not published yet. Use the source checkout path for now:

```bash
git clone https://github.com/avifenesh/ferrings.git
cd ferrings
npm install
npm run build
npm test
```

When the npm packages are published, the intended install path is:

```bash
npm install ferrings
```

The base package is Linux-only and depends on optional native packages for glibc/musl and x64/arm64 targets.

## Quick start

Create `quickstart.js` in the repository root:

```js
'use strict';

const net = require('node:net');
const { createTcpServer, capabilities } = require('./');

console.log(capabilities());

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
    console.log(`listening on tcp://${info.host}:${info.port}`);

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

What happened:

- `createTcpServer()` created a Node-style TCP server backed by a native `io_uring` worker.
- `capabilities()` printed the active kernel probes for this host.
- `useRecvBundle` and `useZeroCopySend` were requested, but remain capability-gated by the native addon.
- The client received `echo:hello` and the server shut down.

## Core concepts

ferrings is not a wrapper around Node's libuv TCP implementation. It creates the listening socket directly with `socket`, `bind`, and `listen`, then drives accepts, receives, sends, and shutdown from a Rust worker thread with `io_uring`.

JavaScript stays in control of the application API:

- Native to JS events are delivered through NAPI thread-safe callbacks.
- JS to native writes go through a bounded command queue and an `eventfd` wakeup.
- Server counters are exposed through `info()` and the initial `ServerInfo` returned by `start()` / `listen()`.
- Kernel-specific features are probed at runtime instead of assumed.

The broad core path is multishot accept + multishot recv + provided buffers. ZCRX is intentionally separate: it requires kernel support, NIC header/data split, flow steering/RSS isolation, permissions, and a capable RX queue.

## Features

- Node-style TCP server facade with `connection`, `data`, `close`, `write()`, `end()`, `destroy()`, `address()`, and `getConnections()`.
- Raw `UringTcpServer` for lower-level event handling, batched event delivery, and batched sends.
- `UringTcpEchoServer` for native TCP echo benchmarks without per-connection JS callbacks.
- `UringHttpServer` for fixed-response HTTP benchmarks on the cleanest `io_uring` path.
- Multishot accept and recv for fewer per-operation submissions on supported kernels.
- Provided buffer rings first, with `IORING_OP_PROVIDE_BUFFERS` fallback when registration is rejected.
- Optional recv-bundle mode using `IORING_FEAT_RECVSEND_BUNDLE` when the kernel advertises it.
- Optional zero-copy send using `IORING_OP_SEND_ZC`, with counters for requests, notifications, copied fallback, and errors.
- Optional registered-buffer send path, guarded by an active startup probe.
- Optional ZCRX path with `zcrxProbe()`, CLI diagnostics, active IFQ registration probe, and hardware smoke tests.
- Bounded command, event, and per-connection send queues so overload is reported instead of growing memory without bound.

## API and usage patterns

### Node-style TCP

```js
const { createTcpServer } = require('./');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => connection.end(data));
});

server.listen(0, '127.0.0.1', (info) => {
  console.log(info);
});
```

Use this path when you want a familiar Node server shape over the native transport.

### Raw TCP events

```js
const { UringTcpServer } = require('./');

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

Use this path when you want direct event objects and explicit connection IDs.

### Batched TCP events and sends

```js
const { UringTcpServer } = require('./');

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

Use this path when JS callback overhead matters and events can be processed in batches.

### Fixed-response HTTP

```js
const { UringHttpServer } = require('./');

const server = new UringHttpServer({
  host: '127.0.0.1',
  port: 0,
  responseBody: 'hello from ferrings\n',
  useZeroCopySend: true
});

const info = server.start();
console.log(`http://${info.host}:${info.port}`);
```

`UringHttpServer` is a benchmark server, not a general HTTP framework.

### Native echo benchmark server

```js
const { UringTcpEchoServer } = require('./');

const server = new UringTcpEchoServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopySend: true
});

const info = server.start();
console.log(`tcp://${info.host}:${info.port}`);
```

Use this to isolate the native TCP echo path from JavaScript event delivery.

### Capability and ZCRX probes

```js
const { capabilities, zcrxProbe } = require('./');

console.log(capabilities());
console.log(zcrxProbe({ interfaceName: 'eth0' }));
console.log(zcrxProbe({
  interfaceName: 'eth0',
  rxQueue: 0,
  activeRegistration: true
}));
```

The CLI exposes the same diagnostics from a source checkout:

```bash
node bin/ferrings.js capabilities --json
node bin/ferrings.js doctor --interface eth0 --rx-queue 0 --active --json
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
```

After npm publishing, the same commands can be run as `npx ferrings ...`.

## Configuration

Common server options:

| Option | Default | Applies to | Purpose |
| --- | ---: | --- | --- |
| `host` | `127.0.0.1` | all servers | Bind address. |
| `port` | `0` | all servers | Bind port; `0` asks the kernel for a free port. |
| `backlog` | `1024` | all servers | Passed to `listen(2)`, subject to host `somaxconn`. |
| `queueDepth` | `1024` | all servers | `io_uring` queue depth. |
| `bufferCount` | `4096` | all servers | Receive buffer slots. |
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

## Performance and benchmarks

The repository includes benchmark drivers, but the README does not publish benchmark numbers because results depend on kernel, CPU, NIC, limits, and benchmark shape.

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
- `benchmark/first-slice.js` writes one compact validation report for the first useful slice across capabilities, HTTP, TCP, and syscall cases.

Set `REPORT_PATH=artifacts/<name>.json` to keep machine-readable reports.

## ZCRX

ZCRX support is present but gated. Use it only on hosts with the right kernel, permissions, NIC support, header/data split, and flow steering/RSS isolation.

```bash
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

`test:zcrx` starts the HTTP, native TCP echo, and programmable TCP servers with `useZeroCopyReceive: true`, drives traffic through `ZCRX_CONNECT_HOST`, and requires `ServerInfo.zcrxPackets` and `zcrxBytes` to increase.

For a real NIC receive proof, avoid `127.0.0.1`; route packets through the selected NIC queue, usually from a second host or a network namespace.

## Release and package layout

The release flow follows napi-rs native package conventions:

- Root package: `ferrings`
- Optional native packages:
  - `ferrings-linux-x64-gnu`
  - `ferrings-linux-x64-musl`
  - `ferrings-linux-arm64-gnu`
  - `ferrings-linux-arm64-musl`

Useful release checks:

```bash
npm run check:native-packages
npm run check:npm-new-names
npm run check:release-repository
npm run check:release-ready -- --full --strict
npm run check:release-ready -- --full --require-zcrx
```

Tag pushes build and upload release artifacts but do not publish to npm. A real npm publish is an explicit manual `workflow_dispatch` run with `publish=true` after npm trusted publishing is configured for the root and native packages.

## Limitations and tradeoffs

- Linux only; there is no macOS or Windows transport.
- Node.js `>=20` is required.
- This is a native addon, so kernel support and process limits affect which fast paths are active.
- The TCP facade is intentionally similar to Node's server shape, but it is not a drop-in replacement for every `net.Server` behavior.
- `UringHttpServer` is a fixed-response benchmark server, not an HTTP application framework.
- TLS is not implemented.
- ZCRX requires specific NIC hardware, kernel support, queue setup, permissions, and routed traffic through the selected RX queue.
- Registered-buffer send can be unavailable even when the kernel supports other modern `io_uring` networking features; ferrings reports that through `capabilities().registeredSendBuffer`.
- APIs and packaging are still at the 0.1 release-candidate stage.

## Docs, examples, and project health

- Examples: [`examples/http-fixed.js`](examples/http-fixed.js), [`examples/tcp-echo.js`](examples/tcp-echo.js)
- Benchmarks: [`benchmark/`](benchmark/)
- Type surface: [`index.d.ts`](index.d.ts), [`native.d.ts`](native.d.ts)
- CLI entrypoint: [`bin/ferrings.js`](bin/ferrings.js)
- Release workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- CI workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
- Tests: [`test/`](test/)

There is no separate docs site yet; the README, type definitions, examples, and tests are the current reference material.

## Contributing

Issues and pull requests are welcome. There is no standalone `CONTRIBUTING.md` yet, so use this baseline before opening a change:

```bash
npm install
npm test
npm run check:release-ready -- --full --strict
```

For changes that touch native packaging, also run:

```bash
npm run check:native-packages
npm run check:publish
```

For ZCRX changes, include `npm run test:zcrx` output when you have access to capable hardware. If you do not, include `node bin/ferrings.js zcrx-probe --all --active --json` output so reviewers can see the blocker.

## License

Licensed under either of:

- [MIT](LICENSE-MIT)
- [Apache-2.0](LICENSE-APACHE)

at your option.
