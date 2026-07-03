# Milestone 081: Production CLI Access Logs

Date: 2026-07-03

## What Changed

- Added `ferrite serve --access-log plain|json` to emit production request observer events to stderr.
- Kept access-log events limited to method, path, status, route pattern, and elapsed milliseconds.
- Avoided request headers and request bodies in CLI access logs so server-action form fields and CSRF tokens are not emitted by this path.
- Updated deployment, architecture, audit, and GTM documentation to separate implemented request outcome logs from remaining metrics/tracing/audit-exporter work.

## Proof

- `cargo test -p ferrite-cli access_log`: passed.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- The CLI access-log path writes to stderr only; there are still no first-class metrics exporters, tracing sinks, or external log-sink configuration.
- Action-specific audit events and trusted-proxy metadata are still future work.
- Remote CI is still unproven because this checkout has no configured Git remote.
