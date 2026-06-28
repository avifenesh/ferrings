# Changelog

All notable changes to ferrings are documented here.

This project follows semver for published npm package versions while it is in the
`0.x` line: patch releases are intended to be safe updates, and minor releases
may adjust APIs, defaults, or packaging.

## Unreleased

- Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates, and a pull
  request template.
- Added Dependabot coverage for npm, Cargo, and GitHub Actions.
- Added package-content checks for contributor, conduct, changelog, and security
  documentation.

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
