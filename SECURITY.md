# Security Policy

## Supported Versions

ferrings is pre-1.0. Security fixes are shipped on the latest published npm version only.

| Version | Supported |
| --- | --- |
| latest `0.x` | Yes |
| older `0.x` | No |

## Reporting A Vulnerability

Please report suspected vulnerabilities through GitHub private vulnerability reporting for this repository:

https://github.com/avifenesh/ferrings/security/advisories/new

If private reporting is unavailable, open a GitHub issue with minimal public detail and ask for a private contact path. Do not include exploit payloads, secrets, host-specific identifiers, or active target details in a public issue.

## What To Include

- A short description of the impact.
- Affected package version and platform target.
- Kernel, Node.js, and Linux distribution versions when relevant.
- Minimal reproduction steps or a small test case.
- Whether the issue requires local code execution, untrusted network input, special NIC capabilities, or elevated permissions.

## Response Expectations

The maintainer will acknowledge valid reports as quickly as practical, confirm the affected surface, and coordinate a patched npm release when needed. For dependency advisories, the project runs npm and RustSec audits in CI and on a weekly schedule.
