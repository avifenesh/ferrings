# Contributing

Thanks for helping make ferrings better. This repo is a Rust+napi-rs native
addon published as one root npm package plus platform-specific native packages,
so changes should keep both the Node API and the native packaging path healthy.

## Development Setup

Requirements:

- Linux
- Node.js 22, 24, or 26
- npm
- Rust stable
- `strace` for syscall benchmark coverage

Install dependencies:

```bash
npm install
```

Run the main validation suite:

```bash
npm test
```

Run dependency audits:

```bash
npm run audit:deps
```

Check package contents:

```bash
npm run check:pack
```

## Common Checks

For native Rust changes:

```bash
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
npm test
```

For TypeScript or public API changes:

```bash
npm run test:types
npm test
```

For packaging changes:

```bash
npm run check:metadata
npm run check:native-packages
npm run check:pack
node test/package-install-smoke.js
node test/platform-package-install-smoke.js
```

For release readiness on a tagged commit:

```bash
npm run check:release-ready -- --full --strict
```

## Benchmarks

Benchmark numbers belong in docs only when they come from a checked-in script or
a clearly documented command.

Useful commands:

```bash
npm run bench
npm run bench:tcp
npm run bench:high
REQUESTS=1000 CONCURRENCY=64 npm run bench:syscalls
```

When updating README benchmark tables, include the machine, kernel, Node, npm,
Rust, workload, and whether the run used loopback or real NIC traffic.

## ZCRX Changes

ZCRX requires capable kernel, NIC, queue, permission, and routing setup. If you
have hardware access, include:

```bash
ZCRX_INTERFACE=<ifname> ZCRX_CONNECT_HOST=<nic-routed-host> npm run test:zcrx
```

If you do not have hardware access, include:

```bash
node bin/ferrings.js zcrx-probe --all --active --json
```

That lets reviewers distinguish unsupported hardware from a transport bug.

## Pull Requests

Good pull requests should include:

- What changed and why.
- Which runtime, kernel, and architecture you tested.
- The exact commands you ran.
- Benchmark output when the change claims performance impact.
- ZCRX probe or hardware-smoke output for ZCRX changes.

Keep unrelated refactors out of functional changes. Native networking bugs are
easier to review when the patch is narrow and the proof is executable.
