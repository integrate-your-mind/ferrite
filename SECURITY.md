# Security policy

Ferrite is a private-alpha framework. It is not approved for unmanaged public
production use or auth-sensitive mutation workloads.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or open a private security
advisory for this repository. Do not publish exploit details in a public issue.
Include the affected revision, a minimal reproduction, expected and observed
behavior, and whether the issue crosses the documented nginx/private-upstream
boundary.

## Supported versions

No released version is supported yet. Security fixes apply only to the exact
private-alpha revision named by the maintainer. Local proof receipts do not
replace hosted deployment or independent review evidence.

## Current boundaries

Ferrite must run behind the documented buffering and header-sanitizing reverse
proxy. Session-bound CSRF rotation, distributed replay state, first-class auth,
file uploads, and external tracing/audit sinks remain outside the current
security claim.
