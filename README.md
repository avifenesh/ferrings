# ferrings

Linux-first Node.js transport experiment built as a Rust/NAPI addon over
`io_uring`.

The current slice exposes three servers:

- `UringTcpServer`: a raw TCP transport that emits `connect`, `data`, and `close`
  events into JavaScript through a NAPI thread-safe function. Writes go back to
  the native worker through an `eventfd` wakeup and are submitted with
  `IORING_OP_SEND`. With `useZeroCopySend: true`, writes are submitted with
  `IORING_OP_SEND_ZC`; when the fixed-send pool is available and the payload fits,
  the worker also uses a registered buffer slot, while larger payloads or hosts
  without fixed-send-buffer registration use heap-backed `SEND_ZC` and keep the
  payload alive until completion/notification. Fixed slots are recycled only
  after the notification CQE. `ServerInfo` reports live
  `zeroCopySendRequests`, `zeroCopySendNotifications`, `zeroCopySendCopied`, and
  `zeroCopySendErrors` counters; ferrings requests
  `IORING_SEND_ZC_REPORT_USAGE` so notification CQEs can distinguish copied
  fallback from true zero-copy use. With `useRegisteredSendBuffer: true`, writes
  use the same fixed-buffer pool with plain `IORING_OP_SEND` and
  `IORING_RECVSEND_FIXED_BUF`, tracked by `registeredSendRequests` and
  `registeredSendErrors`. `capabilities().registeredSendBuffer` actively submits
  a socketpair-backed fixed-buffer `SEND`; if that probe fails, explicitly
  requesting `useRegisteredSendBuffer` fails at startup instead of silently
  running the heap path. If a payload cannot fit in the fixed-send pool, or the
  pool has no free slot, `fixedSendBufferMisses` and `fixedSendBufferMissBytes`
  report the heap fallback. If a later fixed-buffer send is rejected despite the
  startup probe, ferrings falls back to heap-backed `IORING_OP_SEND` and
  increments `registeredSendErrors`. Use `startBatch((events) => {})` to receive
  event arrays and `sendBatch([{ connectionId, data }])` to queue many writes
  behind one worker wakeup. `sendAndClose()` and `sendBatchAndClose()` drain
  queued writes before closing the connection, which matches `socket.end(data)`
  style protocol responses.
- `UringHttpServer`: a fixed-response HTTP benchmark server. It tries to
  register the response buffer and send it with `IORING_OP_SEND_ZC`; if
  zero-copy send is rejected for a connection, that connection falls back to
  normal `IORING_OP_SEND`. With `useRegisteredSendBuffer: true`, the fixed
  response buffer is registered and submitted with plain `IORING_OP_SEND` plus
  `IORING_RECVSEND_FIXED_BUF`; startup is guarded by the same active
  `capabilities().registeredSendBuffer` probe used by the TCP transport.
- `UringTcpEchoServer`: a native TCP echo benchmark server. It uses the same
  multishot accept/recv and provided-buffer path as `UringTcpServer`, but echoes
  one request and closes without per-connection JS callbacks or JS-to-native send
  commands. This isolates the core `io_uring` TCP path from NAPI transport
  overhead. Its send path also honors `useZeroCopySend`, including heap-backed
  `SEND_ZC` when the echoed payload does not fit the fixed-send pool.

The package also exports `createTcpServer()`, a small Node-friendly facade over
`UringTcpServer`. It gives each accepted connection an `EventEmitter` object
with `remoteAddress`, `remoteFamily`, `remotePort`, `write()`, `end()`, and
`destroy()` while keeping the same native io_uring worker, multishot receive
path, bounded command queues, and optional zero-copy send/ZCRX options
underneath. Raw `UringTcpServer` connect events expose the same split peer
fields plus the legacy formatted `remoteAddr` string. The facade also exposes explicit
`sendBatch()` and `sendBatchAndClose()` methods that accept either
`{ connection, data }` or `{ connectionId, data }` entries, so hot paths can
amortize JS-to-native sends without dropping down to the raw `UringTcpServer`.
Use `getConnections((err, count) => {})` for Node-style asynchronous active
connection counts backed by the native transport counters.

Both paths use one native worker thread, multishot accept, multishot recv, and
provided buffers. Each server also has a native `eventfd` wake path so idle
shutdown does not wait for network traffic. They try to use a registered
provided-buffer ring first; if the kernel or process limits reject that
registration, they fall back to `IORING_OP_PROVIDE_BUFFERS` while keeping the
multishot receive path. Pass `useRecvBundle: true` to submit
`IORING_RECVSEND_BUNDLE` multishot receives on kernels that advertise
`IORING_FEAT_RECVSEND_BUNDLE`; this requires the registered provided-buffer ring
path and reports live `ServerInfo.recvBundleCompletions`,
`recvBundleBuffers`, and `recvBundleBytes` counters. Receive health is also
reported through `recvBufferStarvations` for recoverable `-ENOBUFS` multishot
recv completions, `recvMultishotResubmits` for receive requests re-armed
after a multishot CQE without `IORING_CQE_F_MORE`, and `recvCopyEvents` /
`recvCopyBytes` for receive payloads copied out of kernel/provided-buffer
ownership. The fixed-response HTTP server parses request bytes in place before
recycling receive buffers, so its ordinary receive path keeps those copy
counters at zero; programmable TCP and native echo increment them when payloads
must live past buffer recycle for JavaScript delivery or echo sends. ZCRX is
reported via `capabilities()` and the structured `zcrxProbe()` helper, then kept
gated because it requires NIC header/data split, flow steering/RSS isolation,
CQE32 ring setup, and io_uring ifq/memory-region registration. `capabilities()`
actively probes provided-buffer-ring registration, reports kernel
`IORING_OP_RECV_ZC` support, and checks whether ferrings can create the
CQE32/SINGLE_ISSUER/DEFER_TASKRUN ring shape required for ZCRX, queue a
`RecvZc` SQE on it, and complete a socketpair-backed registered-buffer `SEND`
probe for plain fixed-buffer sends. By default `zcrxProbe()` is a
passive sysfs/ethtool/kernel-opcode probe that reports the selected `rxQueue`
and blocks queues outside the discovered RX queue count; pass
`activeRegistration: true` to attempt a short-lived
`IORING_REGISTER_ZCRX_IFQ` registration on the selected RX queue,
allocate/register receive and refill regions, prime the refill queue, and get
the exact errno/result back. Pass `rxBufferSize` to `zcrxProbe()` or
`zcrxRxBufferSize` to a server to try a specific ZCRX `rx_buf_len`; `0` keeps
the kernel default page-sized chunk path, and server startup retries that
default if a nonzero hint is rejected. Passing `useZeroCopyReceive: true` now
starts a CQE32 worker that keeps a persistent ZCRX IFQ registration, submits
multishot `RecvZc`, decodes big-CQE packet offsets, and recycles receive buffers
after the HTTP response, echo payload, or JS-owned event `Buffer` has been
copied into the next ownership boundary. `ServerInfo.zcrxRxBufferSize` reports
the effective registered chunk size, or `0` for the ordinary non-ZCRX path.
`ServerInfo.zcrxPackets` and `zcrxBytes` count valid packets decoded from ZCRX
CQEs for live connections, giving hardware smokes a transport-local proof that
the `RecvZc` path actually received traffic.
Startup still fails with the active registration error on hosts without a
capable NIC queue.

All servers create the listening socket directly with `socket`, `bind`, and
`listen` instead of using libuv. `backlog` defaults to `1024`, is passed to
`listen(2)`, and is reported as `ServerInfo.backlog`; Linux may still cap the
effective pending-connection queue at the host `net.core.somaxconn` setting.
Set `reusePort: true` to apply `SO_REUSEPORT` before `bind(2)`, allowing
multiple ferrings listeners or processes that all opt in to share one TCP
address/port and let Linux distribute accepts across them. The default
`reusePort: false` keeps exclusive listener ownership. Set
`tcpDeferAcceptSeconds` to a positive value to apply `TCP_DEFER_ACCEPT` before
`listen(2)`, so Linux wakes the accept path only after data arrives or the
defer timer expires; the default `0` keeps normal accept behavior.
Accepted sockets default to `tcpNoDelay: true`, matching the low-latency TCP
behavior expected by most Node services; set `tcpNoDelay: false` to leave
Nagle's algorithm enabled for protocols that prefer coalescing. Set
`socketRecvBufferSize` and/or `socketSendBufferSize` to pass non-default
`SO_RCVBUF` / `SO_SNDBUF` values before `listen(2)` and on accepted sockets;
the default `0` leaves the kernel defaults in place, and Linux may report
internally doubled buffer sizes through lower-level tools.

Programmable TCP writes cross from JavaScript to the native worker through a
bounded command queue. `commandQueueCapacity` defaults to `65536`; when the queue
is full, `send()`, `sendAndClose()`, `sendBatch()`, `sendBatchAndClose()`, and
`closeConnection()` return `false` instead of growing memory without bound.
`ServerInfo.commandQueueDrops` reports how often that backpressure path was hit.
After commands reach the worker, each connection also has a bounded native send
backlog: `sendQueueCapacity` defaults to `1024`, and `sendQueueDrops` reports
payloads dropped because one connection already had that many queued writes
behind an active send. The optional fixed-send pool used by
`useRegisteredSendBuffer` and `useZeroCopySend` is sized with
`sendBufferCount` and `sendBufferSize`; programmable TCP and native echo report
those values as `ServerInfo.sendBufferCount` and `sendBufferSize`, while the
fixed-response HTTP server reports `0` because it registers its response body
directly instead of using the per-payload pool.
Native-to-JavaScript event delivery is also bounded: `eventQueueCapacity`
defaults to `65536`, can be lowered for tighter memory envelopes, and
`ServerInfo.eventQueueDrops` reports connect/data/close events dropped when
JavaScript falls behind. `startBatch()` and the public TCP facade flush native
event arrays at `eventBatchSize` events, defaulting to `64`; lower it for
latency-sensitive callbacks or raise it to amortize JS wakeups further. All
servers also report live transport counters through
`activeConnections`, `acceptedConnections`, `closedConnections`,
`rejectedConnections`, `bytesReceived`, and `bytesSent`. Set `maxConnections`
to a positive value to cap tracked active connections; over-limit accepted
sockets are closed immediately and counted in `rejectedConnections`. The default
`maxConnections: 0` keeps the connection count unlimited. Set `idleTimeoutMs`
to a positive value to close idle tracked connections with no active send backlog;
the default `0` disables idle eviction and `ServerInfo.idleTimeouts` reports the
number of native idle closes.

## Usage

```js
const { createTcpServer, UringHttpServer, capabilities, zcrxProbe } = require('./');

console.log(capabilities());
console.log(zcrxProbe({ interfaceName: 'eth0' }));
console.log(zcrxProbe({
  interfaceName: 'eth0',
  rxQueue: 0,
  rxBufferSize: 0,
  activeRegistration: true
}));

const server = new UringHttpServer({
  host: '127.0.0.1',
  port: 0,
  backlog: 1024,
  responseBody: 'hello from io_uring\n',
  idleTimeoutMs: 0,
  tcpNoDelay: true,
  reusePort: false,
  tcpDeferAcceptSeconds: 0,
  socketRecvBufferSize: 0,
  socketSendBufferSize: 0,
  useZeroCopySend: true,
  useRegisteredSendBuffer: false,
  useRecvBundle: false,
  // Requires a capable NIC queue; on ordinary loopback/virtual interfaces this
  // fails with the active ZCRX IFQ registration errno.
  useZeroCopyReceive: false,
  zcrxInterfaceName: 'eth0',
  zcrxRxQueue: 0,
  zcrxRxBufferSize: 0
});

const info = server.start();
console.log(`listening on http://${info.host}:${info.port}`);

process.on('SIGINT', () => {
  server.stop();
});
```

```js
const { createTcpServer } = require('./');

const server = createTcpServer((connection) => {
  connection.on('data', (data) => {
    connection.end(data);
  });
});

server.listen({
  host: '127.0.0.1',
  port: 0,
  backlog: 1024,
  queueDepth: 1024,
  tcpNoDelay: true,
  reusePort: false,
  tcpDeferAcceptSeconds: 0,
  socketRecvBufferSize: 0,
  socketSendBufferSize: 0,
  useRecvBundle: true,
  useZeroCopySend: true
}, (info) => {
  console.log(`listening on tcp://${info.host}:${info.port}`);
});
```

```js
const { createTcpServer } = require('./');

const server = createTcpServer();
server.on('data', (connection, data) => {
  server.sendBatchAndClose([
    { connection, data: Buffer.from('echo:') },
    { connectionId: connection.id, data }
  ]);
});
```

```js
const net = require('node:net');
const { UringTcpServer } = require('./');

const server = new UringTcpServer({
  host: '127.0.0.1',
  port: 0,
  backlog: 1024,
  maxConnections: 0,
  idleTimeoutMs: 0,
  tcpNoDelay: true,
  reusePort: false,
  tcpDeferAcceptSeconds: 0,
  socketRecvBufferSize: 0,
  socketSendBufferSize: 0,
  commandQueueCapacity: 65536,
  eventQueueCapacity: 65536,
  eventBatchSize: 64,
  sendQueueCapacity: 1024,
  sendBufferCount: 256,
  sendBufferSize: 2048,
  useRecvBundle: true,
  useRegisteredSendBuffer: true,
  useZeroCopySend: false
});
const info = server.start((event) => {
  if (event.eventType === 'data') {
    server.send(event.connectionId, Buffer.from('pong'));
  }
});

const client = net.createConnection(info.port, info.host, () => {
  client.write('ping');
});
```

```js
const { UringTcpEchoServer } = require('./');

const echoServer = new UringTcpEchoServer({
  host: '127.0.0.1',
  port: 0,
  useZeroCopySend: true
});
const echoInfo = echoServer.start();
console.log(`native TCP echo on ${echoInfo.port}`);
```

```js
const batchServer = new UringTcpServer({ host: '127.0.0.1', port: 0 });
const batchInfo = batchServer.startBatch((events) => {
  const sends = [];
  for (const event of events) {
    if (event.eventType === 'data') {
      sends.push({ connectionId: event.connectionId, data: Buffer.from('pong') });
    }
  }
  if (sends.length > 0) batchServer.sendBatchAndClose(sends);
});
console.log(batchInfo.port);
```

## Commands

```sh
npm install
npm test
npm run bench
npm run check:npm-names
npm run check:npm-new-names
npm run check:github-repository
npm run check:release-repository
npm run check:release-ready
npm run configure:release-repository -- --repo avifenesh/ferrings
npm run bench:first-slice
npm run bench:tcp
npm run bench:high
npm run example:http
npm run example:tcp
npx ferrings capabilities --json
npx ferrings doctor --interface eth0 --rx-queue 0 --active --json
npx ferrings zcrx-probe --interface eth0 --rx-queue 0 --active --json
npx ferrings zcrx-smoke --interface eth0 --rx-queue 0 --connect-host <nic-routed-host> --report-path artifacts/zcrx-smoke.json --json
REQUESTS=1000 CONCURRENCY=32 npm run bench:syscalls
REPORT_PATH=artifacts/high-concurrency.json DURATION_MS=1000 CONCURRENCY=128 npm run bench:high
REPORT_PATH=artifacts/first-slice.json DURATION_MS=1000 CONCURRENCY=128 SYSCALL_REQUESTS=200 npm run bench:first-slice
REPORT_PATH=artifacts/syscalls.json REQUESTS=1000 CONCURRENCY=32 npm run bench:syscalls
ZCRX_INTERFACE=eth0 ZCRX_RX_QUEUE=0 ZCRX_RX_BUFFER_SIZE=0 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
ZCRX_INTERFACE=eth0 ZCRX_RX_QUEUE=0 ZCRX_REQUIRE_RX_QUEUE_STATS=1 ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
ZCRX_INTERFACE=eth0 ZCRX_CONNECT_HOST=<nic-routed-host> ZCRX_REPORT_PATH=artifacts/zcrx-smoke.json npm run test:zcrx
```

`bench:first-slice` is the compact validation report for the first useful
slice: it records `capabilities()`, runs the fixed-response HTTP benchmark
against Node's `http` server and `UringHttpServer`, runs the TCP echo matrix
against Node's `net` server and the ferrings native/programmatic/facade echo
paths, and, when `strace` is installed, runs the syscall-per-connection
benchmark for Node HTTP, ferrings HTTP, Node TCP, the public ferrings TCP facade,
and ferrings native TCP. Set `REPORT_PATH` to write one JSON artifact with child
reports and headline comparisons. `bench` and `bench:tcp` report throughput plus
p50/p95/p99 request latency.
`bench:tcp` includes native echo recv-bundle variants when
`capabilities().recvBundle` is true, using `BUNDLE_REQUEST_SIZE=4096` by default
so the receive path spans multiple 512-byte buffers. `bench:high` runs both
HTTP and TCP benchmarks with high-concurrency defaults (`CONCURRENCY=512`,
`QUEUE_DEPTH=1024`, `DURATION_MS=10000`), and those environment variables remain
overridable for shorter smoke runs. `bench:syscalls` requires `strace`. It runs
only the server under `strace -f -c`, drives requests from an untraced parent
process, and reports latency plus server-side syscalls per completed connection;
ferrings cases include a compact `serverInfo` summary so the measurement records
whether the worker actually started with multishot recv, a provided-buffer ring,
recv-bundle, receive-copy counters, and zero-copy send enabled. Its default case
list also reports fixed-send-buffer misses, includes the public TCP facade and
facade batch paths, adds HTTP/TCP zero-copy-send variants when
`capabilities().sendZc` is true, native TCP recv-bundle variants when
`capabilities().recvBundle` is true, and the combined zero-copy-send recv-bundle
case when both are available. Use
`CASES=ferrings-native-tcp-recv-bundle,ferrings-native-tcp-zc-recv-bundle` to
target those cases, and `BUNDLE_REQUEST_SIZE` to resize the multi-buffer request.
The fixed-response HTTP server is the cleanest core `io_uring` path; raw TCP
results also include NAPI thread-safe callback delivery and JS-to-native command
wakeups. Set `REPORT_PATH` for `bench`, `bench:tcp`, `bench:high`, or
`bench:syscalls` to write a JSON report with the benchmark configuration,
results, and ferrings `serverInfo` feature summaries. `bench:high` writes one
aggregate report that nests the HTTP and TCP child benchmark reports.

The installed package also exposes a `ferrings` CLI. `ferrings capabilities`
prints active kernel/io_uring probes, while `ferrings doctor` combines the core
transport probes with one selected ZCRX NIC probe and prints a single verdict,
blocker list, and next command. `ferrings zcrx-probe` reports ZCRX readiness for
a selected NIC queue. Add `--json` or `--compact` for automation, `--all` to
inspect every `/sys/class/net` interface, `--active` to attempt a short-lived
ZCRX IFQ registration, and `--require-ready` to fail with exit code `2` when the
selected queue is not ready. `ferrings zcrx-smoke` runs the full hardware
traffic proof from the installed package: it starts the HTTP, native TCP echo,
and programmable TCP servers with `useZeroCopyReceive: true`, drives traffic
through `--connect-host`, requires `ServerInfo.zcrxPackets` and `zcrxBytes` to
increase for each server, and can write the same JSON report as `test:zcrx` with
`--report-path`.

The native package layout follows the napi-rs generated-binding path:
`npm run build` runs `napi build --platform --js native.js --dts native.d.ts`,
leaving the generated loader, generated types, and `ferrings.*.node` binary in
the same package directory as the public `index.js` facade. The package install
smoke packs the tarball, installs it in a temporary app, checks those copied
files, starts a TCP server through `require('ferrings')`, and runs the installed
`.bin/ferrings` CLI.
The base package is Linux-only and declares napi-rs targets for
`linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, and
`linux-arm64-musl`. The local tarball smoke still includes the host
`ferrings.linux-x64-gnu.node` binary so it can be installed directly from a
packed tarball, while CI also builds the extra Linux target artifacts. Public
multi-target publishing should ship the base package plus the matching optional
native packages under `npm/linux-*/`, each with its own `os`/`cpu`/`libc`
constraints. The release staging flow mirrors napi-rs: put built `.node`
artifacts under `artifacts/`, run `npm run artifacts` to copy them into
`npm/linux-*` and add shared license files, then run
`npm run check:native-packages` or
`node scripts/check-native-packages.js --package linux-x64-gnu --require-binary`
to dry-run pack the staged native package.
Use `npm run check:npm-names` before publishing to verify that the root package
and optional native package versions are not already present on the npm
registry. For the initial claim of the package family, use
`npm run check:npm-new-names` to require every package name to be completely
unpublished.
The release workflow uses npm trusted-publishing/provenance-friendly defaults:
GitHub-hosted runners, `id-token: write`, Node 24, public package access, and
`publishConfig.provenance` on the root and native package manifests. Before a
real publish, create a public GitHub repository, set
`package.json.repository.url` to that exact repository, then configure each npm
package's trusted publisher to that repository and workflow. Tag pushes build
and upload release artifacts but do not publish to npm; npm publish is an
explicit manual `workflow_dispatch` run with `publish=true` after trusted
publishing is configured. The release workflow blocks publishing when GitHub's
`GITHUB_REPOSITORY` does not match the package repository metadata.
After adding a GitHub `origin`, run `npm run configure:release-repository` to
derive that metadata from the remote, or pass `--repo owner/name` explicitly.
The helper edits the root `package.json` and every `npm/linux-*` native package
manifest; it does not create a repository, push, or publish.
Run `npm run check:release-ready` for one aggregate local release verdict. By
default it fails only local package/repository defects and prints external
blockers separately. ZCRX hardware proof is reported as optional because the
0.1 core release is useful without a ZCRX-capable NIC. Pass `-- --strict` to
make required external repository gates fail the command, and pass
`-- --require-zcrx` when a ZCRX-capable NIC proof should gate the release.

`test:zcrx` is skipped unless `ZCRX_INTERFACE` is set. On capable hardware it
starts all three server types with `useZeroCopyReceive: true`, requires the
active IFQ registration probe to pass, and drives HTTP/native echo/programmable
TCP traffic through `ZCRX_CONNECT_HOST`. Each smoke requires
`ServerInfo.zcrxPackets` and `zcrxBytes` to increase, so a passing run proves
that ferrings decoded traffic from ZCRX CQEs in addition to completing the
application round trip. Set `ZCRX_RX_BUFFER_SIZE` to try a
large `rx_buf_len` hint; `0` uses the kernel default and is the broadest
compatibility path. When the NIC driver exposes recognizable `ethtool -S`
per-RX-queue traffic counters, the hardware smoke records before/after deltas
for the selected queue and fails if traffic completes without a counter
increase. Set `ZCRX_REQUIRE_RX_QUEUE_STATS=1` to also fail when those counters
are unavailable. For a real NIC RX validation, `ZCRX_CONNECT_HOST` must route
packets through the selected NIC queue; a second host or network namespace is
usually less misleading than connecting to `127.0.0.1`. Set `ZCRX_REPORT_PATH`
to write a JSON report containing the active probe result, each HTTP/native
echo/programmable TCP smoke result, and any selected RX queue counter deltas.
