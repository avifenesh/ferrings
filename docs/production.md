# Production Runbook

This runbook is for deploying ferrings in Linux Node.js services and validating
that the native transport is actually active.

## Supported Targets

- Linux only.
- Node.js 22, 24, or 26. Node 26 is the current release line; Node 24 and 22
  are LTS.
- `x64` or `arm64`.
- glibc or musl.
- The root package must install one matching optional native package:
  `ferrings-linux-x64-gnu`, `ferrings-linux-x64-musl`,
  `ferrings-linux-arm64-gnu`, or `ferrings-linux-arm64-musl`.

## Install Verification

Run these on the target host after installation:

```bash
npx ferrings --version
node -e "console.log(require('ferrings').capabilities())"
npx ferrings doctor --json
npx ferrings capabilities --json
```

A healthy normal deployment should show:

- `backend: "io_uring"` in server info.
- `ioUringAvailable: true`.
- `acceptMulti: true` and `recvMulti: true` on recent kernels.
- `providedBufferRing: true` when the host supports provided buffer rings.
- No `FerringsNativeLoadError` at process startup.

If loading fails, reinstall with optional dependencies enabled and check that
the matching native package exists under `node_modules/`.

## Runtime Counters

All servers expose `ServerInfo`. In production, export or log at least:

- `acceptedConnections`
- `closedConnections`
- `rejectedConnections`
- `bytesReceived`
- `bytesSent`
- `recvBufferStarvations`
- `eventQueueDrops`
- `sendQueueDrops`
- `fixedSendBufferMisses`
- `zeroCopySend`
- `zcrxReady`
- `zcrxPackets`
- `zcrxBytes`

Treat increasing queue drops, receive buffer starvation, or fixed-send misses as
capacity signals. Raise queue, receive-buffer, or send-buffer limits only after
checking `RLIMIT_MEMLOCK`, process memory, and workload shape.

## Deployment Defaults

Start with the normal multishot/provided-buffer path:

```js
const { createTcpServer } = require('ferrings');

const server = createTcpServer(
  {
    host: '0.0.0.0',
    port: 8080,
    backlog: 1024,
    queueDepth: 64,
    bufferCount: 512,
    bufferSize: 2048,
    useRecvBundle: true,
    useZeroCopySend: true
  },
  (connection) => {
    connection.on('data', (data) => {
      connection.end(data);
    });
  }
);

server.listen();
```

Tune from counters rather than from defaults alone. Larger `queueDepth`,
`bufferCount`, `sendBufferCount`, and fixed buffers can require a higher locked
memory limit.

## Benchmarking A Host

Run same-host comparisons before claiming a production win:

```bash
REQUESTS=1000 CONCURRENCY=64 QUEUE_DEPTH=64 BUFFER_COUNT=512 BUFFER_SIZE=2048 \
CASES=node-http,ferrings-http,node-tcp,ferrings-native-tcp,ferrings-tcp-facade,ferrings-tcp-facade-batch \
REPORT_PATH=artifacts/benchmark-production.json \
npm run bench:syscalls
```

Watch throughput and server syscalls per completed connection. Tail latency is
sensitive to JavaScript callback work, payload size, queue depth, CPU governor,
kernel, and whether traffic uses loopback or a real NIC path.

## ZCRX Validation

ZCRX is not the default production path. Enable it only after the selected host
passes active probing and traffic validation.

Requirements:

- Kernel exposes `IORING_OP_RECV_ZC`.
- `io_uring` CQE32 ring setup succeeds.
- Physical NIC supports the required zero-copy receive path.
- Header/data split and queue setup are configured for the NIC.
- Flow steering or RSS keeps traffic on the selected RX queue.
- The process has permission for IFQ registration and locked memory.
- Client traffic is routed through the selected NIC queue.

Validation command:

```bash
node bin/ferrings.js zcrx-probe --interface eth0 --rx-queue 0 --active --json
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

`ZCRX_CONNECT_HOST` must be a concrete non-loopback host routed through the
selected NIC path. Do not use `127.0.0.1`, `localhost`, `0.0.0.0`, or `::`.

The hardware smoke test starts HTTP, native TCP echo, and programmable TCP
servers with `useZeroCopyReceive: true`, sends traffic through
`ZCRX_CONNECT_HOST`, and requires `zcrxPackets` and `zcrxBytes` to increase.

## Release Verification

Before tagging:

```bash
npm test
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
npm run audit:deps
npm run check:release-ready -- --full --strict
```

For releases that intentionally require ZCRX hardware evidence:

```bash
ZCRX_INTERFACE=<ifname> ZCRX_CONNECT_HOST=<nic-routed-host> \
npm run check:release-ready -- --full --require-zcrx
```

After publication:

```bash
npm run check:published -- --tag latest --verify-tarballs
npm run check:registry-install -- --version "$(node -p "require('./package.json').version")"
npm run check:main-health -- --full
```

## Rollback

Npm versions are immutable, so rollback is an application-level dependency
change:

```bash
npm install ferrings@<previous-version>
```

Verify that the matching native optional package version is installed with the
root package. For production services, pin exact versions in lockfiles and roll
forward with a new patch release when possible.
