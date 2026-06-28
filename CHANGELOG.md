# Changelog

All notable changes to ferrings are documented here.

This project follows semver for published npm package versions while it is in the
`0.x` line: patch releases are intended to be safe updates, and minor releases
may adjust APIs, defaults, or packaging.

## Unreleased

- Rewrote the README to lead with the benchmark proof and present ferrings as a
  usable Linux `io_uring` transport, with ZCRX described as a gated fast path
  rather than the baseline product story.
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
