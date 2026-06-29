# Changelog

All notable changes to ferrings are documented here.

This project follows semver for published npm package versions while it is in the
`0.x` line: patch releases are intended to be safe updates, and minor releases
may adjust APIs, defaults, or packaging.

## Unreleased

## 0.2.46 - 2026-06-29

- Hardened package metadata checks so release gates fail when package `files`,
  concrete export targets, export pattern directories, `main`, `types`, or CLI
  bin paths point at missing files or directories.
- Refreshed the README benchmark snapshot with `ferrings@0.2.46` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.45 - 2026-06-29

- Hardened root `zcrxProbe()` option validation so buffers, dates, arrays, and
  class instances are rejected before reaching the native probe while plain and
  `Object.create(null)` option records remain supported.
- Refreshed the README benchmark snapshot with `ferrings@0.2.45` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.44 - 2026-06-29

- Rewrote the README opening to present ferrings as a usable Linux Node
  transport, keep benchmark results in the first screen and as the first
  top-level section, and describe ZCRX as an optional receive fast path rather
  than the default story.
- Refreshed the README benchmark snapshot with `ferrings@0.2.44` results on
  Node 26 using 5,000 completed requests per case.
- Hardened TCP facade native event delivery so throwing connection/data/close
  listeners do not prevent server-level event emission, connection cleanup, or
  later events already delivered in the same native batch; the first listener
  error is still rethrown to preserve visible failure semantics.
- Closed and emitted close events for any tracked facade connection replaced by
  a duplicate native connect event before installing the new connection object.
- Hardened TCP facade lifecycle cleanup by ignoring late native event batches
  after `server.close()` and keeping internal state clean across native startup
  failures, throwing startup callbacks/listeners, native stop failures, and
  throwing connection-close listeners while still completing server close
  callbacks/events.
- Rejected invalid `server.close()` callbacks before stopping the native server
  so caller argument errors do not partially close a running facade.
- Aligned the facade `start()` runtime contract with its TypeScript overloads:
  `start()` now accepts only options and callback arguments, while Node-style
  port/host/backlog overloads remain on `listen()`.
- Guarded facade batch sends so connection objects must belong to the target
  server and destroyed connection objects cannot bypass `connection.write()`
  liveness checks or force payload conversion, with runtime validation matching
  the typed connection-or-connectionId union.
- Made facade batch sends by `connectionId` respect known local connection
  liveness and mark tracked connections destroyed when
  `sendBatchAndClose([{ connectionId }])` is accepted.
- Made facade connection identity fields immutable at runtime and kept the
  internal server owner reference non-enumerable and non-writable.
- Rejected unsupported extra `listen()` arguments instead of silently ignoring
  values outside the documented overloads, and rejected object-options calls
  combined with positional host/backlog arguments.
- Rejected invalid `createTcpServer()` constructor options and non-function
  connection listeners before they can be treated as empty defaults.
- Rejected non-record facade option and batch-send objects such as buffers,
  dates, arrays, and class instances while continuing to accept plain and
  `Object.create(null)` option records.

## 0.2.43 - 2026-06-29

- Widened live `ServerInfo` runtime counters from 32-bit reported values to
  JavaScript-safe numeric counters backed by the existing `AtomicU64` stats, so
  long-running services do not flatten byte and event counters at `u32::MAX`.
- Refreshed the README benchmark snapshot with `ferrings@0.2.43` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.42 - 2026-06-29

- Preserved `trafficRoute` evidence in failed ZCRX hardware smoke reports when
  `ZCRX_CONNECT_HOST` resolves to a route whose device does not match
  `ZCRX_INTERFACE`, including the route blocker string in the public type.
- Refreshed the README benchmark snapshot with `ferrings@0.2.42` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.41 - 2026-06-29

- Hardened ZCRX hardware smoke validation so `ZCRX_CONNECT_HOST` must resolve
  to an address whose `ip -json route get` device matches `ZCRX_INTERFACE`
  before any receive traffic is accepted as hardware evidence.
- Refreshed the README benchmark snapshot with `ferrings@0.2.41` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.40 - 2026-06-29

- Reframed the README around ferrings as a usable default `io_uring` TCP
  transport, promoted the benchmark snapshot into the opening, and kept ZCRX as
  an optional host-gated receive path.
- Refreshed the README benchmark snapshot with `ferrings@0.2.40` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.39 - 2026-06-29

- Tightened the README opening so the benchmark results appear immediately after
  the installable transport summary, with ZCRX kept as an optional host-gated
  receive path.
- Refreshed the README benchmark snapshot with `ferrings@0.2.39` results on
  Node 26 using 5,000 completed requests per case.

## 0.2.38 - 2026-06-29

- Added structured native-loader attempt diagnostics to
  `FerringsNativeLoadError`, `ferrings doctor --json`, package-install smoke
  coverage, and future registry-install verification.
- Refreshed the README benchmark snapshot with `ferrings@0.2.38` results on
  Node 26.
- Enforced Clippy's `undocumented_unsafe_blocks` lint and documented the safety
  invariants around native FFI, mmap, fd ownership, provided-buffer rings, and
  io_uring submission helpers.
- Rewrote the README first screen around ferrings as an installable, usable
  transport, moved the benchmark headline into the first section, and tightened
  public-doc wording away from proof-oriented framing.
- Added a tracked-file secret scan for npm, GitHub, AWS, npmrc, and private-key
  patterns, wired it into `npm test` and the Security workflow.

## 0.2.37 - 2026-06-29

- Rewrote the README opening so ferrings presents as a ready-to-use transport,
  refreshed the `0.2.37` benchmark snapshot, and moved install/quick-start
  usage directly next to the benchmark evidence.
- Updated the README metadata regression test so the ready-use framing guard
  covers the new opening sentence.
- Added explicit Release workflow timeouts for quality, publish, registry
  verification, and GitHub release steps, with workflow-policy checks to keep
  those bounds in place.
- Bounded the workflow checker's actionlint download and child-process calls so
  workflow validation cannot hang indefinitely while bootstrapping tooling.
- Added explicit CI and Security workflow job/step timeouts and made
  workflow-policy checks enforce those runner bounds.

## 0.2.36 - 2026-06-29

- Rewrote the README first screen to present ferrings as a ready-to-use Node
  transport and put benchmark evidence directly under the opening.
- Added a release-local quality gate so npm publication waits for format,
  clippy, test, and dependency-audit checks in the Release workflow itself.
- Split release publishing into an explicit package-set publisher so native
  packages publish before the root package and root `prepublishOnly` skips the
  optional-package publish path.

## 0.2.34 - 2026-06-29

- Added retry support to the registry install smoke and wired the release
  workflow to retry post-publish install validation while npm registry metadata
  propagates.

## 0.2.33 - 2026-06-29

- Hardened the registry install smoke so published packages must prove the
  `doctor` default-readiness contract from an npm install.
- Made the CLI lazy-load the native binding so `ferrings --version` and help
  still work when optional native packages are missing, and `doctor --json`
  returns a structured `native-load-blocked` report.

## 0.2.32 - 2026-06-29

- Reworked `ferrings doctor` so default transport readiness is separated from
  optional ZCRX readiness. ZCRX blockers now stay under `optionalBlockers`
  unless `--require-zcrx` is passed.
- Rewrote the README opening around production use and refreshed the benchmark
  snapshot with `ferrings@0.2.32` results on Node 26.

## 0.2.31 - 2026-06-29

- Added a post-publish `main-health` check that verifies the lockfile can
  install with optional native packages enabled, matching normal production
  installs after a version is published.
- Expanded the registry install smoke so release verification checks the
  published CJS/ESM entrypoints, subpath exports, CLI diagnostics, and TCP
  roundtrip from the npm-installed package.
- Added Node 26 version-manager pins and an early `main-health` runtime check
  so unsupported Node lines fail with a clear message before install smoke
  checks.

## 0.2.30 - 2026-06-29

- Hardened release workflow reruns so already-published versions skip native
  rebuilds and go straight to registry verification and install smoke checks.
- Tightened package engine metadata to the tested Node 22, 24, and 26 lines so
  EOL odd-numbered Node releases are not advertised as supported.
- Refreshed the README benchmark snapshot with `ferrings@0.2.30` results on
  Node 26.

## 0.2.29 - 2026-06-29

- Rewrote the README first screen so ferrings leads with release-package
  benchmark results and production Node transport positioning.
- Refreshed the README benchmark snapshot with `ferrings@0.2.29` results on
  Node 26.

## 0.2.28 - 2026-06-29

- Added TypeScript declarations for the public `tcp-transport` and
  `zcrx-smoke` subpaths, with package metadata and installed-package smoke
  coverage so the exported JavaScript subpaths stay typed.

## 0.2.27 - 2026-06-29

- Hardened release workflow token permissions so validation/build jobs run with
  read-only repository access while npm provenance and GitHub release writes are
  scoped to the publish job.
- Added TCP facade `listen()` validation for invalid host, port, and backlog
  inputs so common deployment misconfiguration fails before native startup.
- Added root `zcrxProbe()` option validation so invalid queue, buffer-size,
  interface, and active-registration inputs cannot be silently coerced before
  probing.
- Rewrote the README opening to lead with release-package benchmark results and
  present ferrings as usable for supported Linux Node deployments.
- Tightened the README positioning so ferrings is described as a production
  Node transport, with benchmark results before implementation detail.
- Hardened native server option validation so fractional or negative JavaScript
  numbers cannot be coerced into ports, queue sizes, buffer sizes, counters, or
  ZCRX queue settings before startup.
- Hardened raw TCP send and close methods so fractional, negative, overflow,
  `NaN`, or infinite `connectionId` values cannot be coerced before native
  command enqueue.
- Hardened the raw native ZCRX probe so invalid `rxQueue`, `rxBufferSize`, and
  empty `interfaceName` values are rejected before readiness probing or active
  registration checks.
- Hardened `zcrx-smoke` and CLI numeric option parsing so invalid RX queue,
  RX buffer size, and timeout values fail before hardware validation starts.

## 0.2.26 - 2026-06-29

- Added ZCRX kernel security advisory warnings for affected upstream release
  ranges and block `useZeroCopyReceive` startup unless the operator explicitly
  overrides after verifying a vendor backport.
- Refreshed the README benchmark snapshot with `ferrings@0.2.26` results on
  Node 26.

## 0.2.25 - 2026-06-29

- Added `ferrings --version` / `ferrings version` CLI support and covered it in
  source and installed-package smoke tests.
- Refreshed the README benchmark snapshot with `ferrings@0.2.25` results on
  Node 26.

## 0.2.24 - 2026-06-29

- Rewrote the README first screen so ferrings is presented as a usable npm
  transport with install, a minimal server, and benchmark evidence before the
  longer API reference.
- Refreshed the README benchmark snapshot with `ferrings@0.2.24` results on
  Node 26.

## 0.2.23 - 2026-06-29

- Added ESM wrapper entrypoints for root and native imports so Node ESM
  consumers can use named imports while CommonJS `require()` behavior stays
  unchanged.
- Added installed-package runtime and TypeScript NodeNext smoke coverage for
  the ESM entrypoints.

## 0.2.22 - 2026-06-29

- Rewrote the README opening to present ferrings as a usable Node transport
  with benchmark evidence before installation.
- Added explicit `exports` boundaries to every native platform package and
  extended local, install-smoke, and published-registry checks to verify them.

## 0.2.21 - 2026-06-29

- Added a package `exports` map that defines the supported public entrypoint
  boundary while preserving shipped JavaScript subpaths.
- Added metadata and installed-tarball smoke coverage for the export map so
  package-boundary drift is caught before publish.

## 0.2.20 - 2026-06-29

- Added a packaged production runbook covering install verification, operational
  counters, benchmark interpretation, ZCRX validation, release checks, and
  rollback.

## 0.2.19 - 2026-06-29

- Rewrote the README opening so ferrings is presented as a usable transport,
  with benchmark evidence visible before installation.
- Hardened ZCRX hardware smoke validation so selecting an interface requires a
  concrete non-loopback `ZCRX_CONNECT_HOST` routed through the selected NIC path.
- Added CLI and release-gate coverage for missing, loopback, and wildcard ZCRX
  connect-host configuration.
- Refreshed the README benchmark snapshot with `ferrings@0.2.19` results on
  Node 26.

## 0.2.18 - 2026-06-29

- Removed the native binary from the root package tarball so all supported
  Linux targets load through the same optional platform-package path.
- Tightened package, tarball, and registry-install checks to reject native
  binaries in the root package and prove the platform package is installed.

## 0.2.17 - 2026-06-29

- Renamed the packaged quick benchmark runner to `quick-benchmark`, and
  extended metadata checks so public benchmark naming stays benchmark-oriented.

## 0.2.16 - 2026-06-29

- Reworded the installed CLI help so ZCRX smoke is described as traffic
  validation, and extended metadata checks to guard public CLI framing.

## 0.2.15 - 2026-06-29

- Rewrote the README opening and benchmark section to present ferrings as a
  usable Linux `io_uring` TCP transport first, with benchmarks as the primary
  evidence and ZCRX framed as an optional hardware-gated path.

## 0.2.14 - 2026-06-29

- Added release metadata guards that keep the README benchmark section first
  and prevent public preview framing from returning.
- Added a Rust lint policy that denies `unsafe_op_in_unsafe_fn`, with metadata
  regression coverage and a safety rationale on the native buffer-ring `Send`
  contract.
- Hardened `check:release-ready -- --require-zcrx` so it requires a
  non-loopback hardware route and runs the ZCRX hardware smoke test instead of
  accepting environment configuration as validation.
- Refreshed the README benchmark snapshot with `ferrings@0.2.14` results on
  Node 26.

## 0.2.13 - 2026-06-29

- Renamed the packaged quick benchmark bundle to `quick-benchmark` and exposed it
  as `npm run bench:quick`, removing early-stage wording from the public
  package surface.
- Refreshed the README benchmark snapshot with `ferrings@0.2.13` results on
  Node 26.

## 0.2.12 - 2026-06-29

- Rewrote the README to lead with the benchmark evidence and present ferrings as a
  usable Linux `io_uring` transport, with ZCRX described as a gated fast path
  rather than the baseline product story.
- Refreshed the README benchmark snapshot with `ferrings@0.2.12` results on
  Node 26.
- Covered the cargo-audit installer helper in Security workflow path filters so
  audit tooling changes cannot skip the workflow.

## 0.2.11 - 2026-06-29

- Fixed the Node-style TCP facade `listen(port, host)` parser so numeric-looking
  string hosts are treated as hosts, matching Node's `net.Server.listen()`
  signature instead of being reinterpreted as backlog values.

## 0.2.10 - 2026-06-29

- Reworked the README opening to present ferrings as a usable Linux transport,
  with benchmark results in the first-screen flow instead of lower in the page.

## 0.2.9 - 2026-06-29

- Added root package `cpu` and `libc` selectors so unsupported Linux targets
  are rejected during install instead of failing later at native-load time.
- Added published-package verification for the root `cpu` and `libc` metadata.

## 0.2.8 - 2026-06-29

- Added a metadata gate that keeps the README benchmark provenance aligned with
  the current package version.
- Added native package metadata gates for direct platform-package installs,
  including Node engine, keywords, and target descriptions.
- Refreshed the README benchmark snapshot with `ferrings@0.2.8` results on Node
  26.

## 0.2.7 - 2026-06-29

- Added a `check:main-health` gate for validating current `main` after a
  release without weakening the stricter next-release tag checks.
- Added hosted CI coverage for `check:main-health -- --full` so the
  post-release health gate cannot drift silently.
- Added published npm tarball-content verification for the root package and all
  native packages.
- Rewrote the README opening and benchmark section to present ferrings as a
  usable transport first and refresh the Node 26 benchmark table.
- Added a registry install smoke check that installs the published package,
  forces the optional native platform package path, starts a TCP server, and
  runs the installed CLI.
- Added a verified repo-owned Zig installer for cross-build jobs so CI and
  release builds no longer depend on a Node 20-based setup action or direct
  unverified Zig tarball streams.

## 0.2.6 - 2026-06-28

- Added a pinned `actionlint` workflow checker and CI job, and included it in
  release-readiness checks.
- Added a recv-bundle buffer-starvation regression that forces a tiny
  provided-buffer ring to recover with multishot receive resubmits while all TCP
  round trips complete.
- Made release-readiness checks registry-aware so an already-published version
  asks for a version bump instead of retagging or running noisy publish
  dry-runs.
- Made CI, security, and release dependency installs omit optional native
  packages so patch releases can validate before the new platform packages exist
  on npm.
- Added a lockfile install-plan gate to release readiness so future version
  bumps catch optional-native package lock drift before tagging.
- Rewrote the README to strengthen the usable Linux `io_uring` transport
  positioning and keep the full benchmark table before installation with an
  explicit Node 20 EOL support note.

## 0.2.5 - 2026-06-28

- Added a public `FerringsNativeLoadError` with code
  `FERRINGS_NATIVE_LOAD_FAILED` when native bindings cannot be loaded.
- Documented the native-load diagnostic and covered the missing-binding path in
  the packed-package install smoke test.
- Repositioned the README around ferrings as a ready-to-use transport and moved
  benchmark reproduction into the first-screen flow.

## 0.2.4 - 2026-06-28

- Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates, and a pull
  request template.
- Added Dependabot coverage for npm, Cargo, and GitHub Actions.
- Added package-content checks for contributor, conduct, changelog, and security
  documentation.
- Updated the direct `io-uring` dependency to `0.7.13`.

## 0.2.3 - 2026-06-28

- Rewrote the README to lead with ferrings as a usable Linux `io_uring` TCP
  transport.
- Moved benchmark results near the top of the README and refreshed the headline
  benchmark on Node `v26.4.0`.
- Added production-readiness gates for metadata, package contents, type smoke
  tests, dependency audits, release checks, and npm package provenance.
- Added the Security workflow and `SECURITY.md`.
- Published root and native packages for:
  - `ferrings`
  - `ferrings-linux-x64-gnu`
  - `ferrings-linux-x64-musl`
  - `ferrings-linux-arm64-gnu`
  - `ferrings-linux-arm64-musl`

## 0.2.2 - 2026-06-28

- Published the first broadly usable package split with platform-specific native
  npm packages.
- Added lockfile refresh workflow after publishing native packages.

## 0.2.1 - 2026-06-28

- Added release automation and package-install smoke checks.

## 0.2.0 - 2026-06-28

- Added the Node-style TCP facade on top of the native `io_uring` transport.
- Added benchmark scripts for HTTP, TCP echo, high-concurrency runs, and syscall
  accounting.

## 0.1.0 - 2026-06-28

- Initial Linux `io_uring` TCP transport with Rust+napi-rs bindings.
- Added multishot accept/recv, provided buffer rings, zero-copy send probes, and
  ZCRX readiness probes.
