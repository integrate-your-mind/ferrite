# Milestone 078: Production Serve Limit Flags

Date: 2026-07-03

## What Changed

- Added `ferrite serve` CLI flags for the production adapter's request-read timeout, maximum request bytes, and maximum in-flight request count.
- Kept `render_timeout_ms` in JSON output and added effective limit fields for deployment automation.
- Updated deployment and status docs so the production CLI no longer claims those low-level limits are Rust API-only.

## Proof

- `cargo test -p ferrite-cli`: passed.
- `cargo fmt --all -- --check`: passed.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- The CLI exposes production limit controls, but it still does not expose structured log sinks, metrics exporters, trusted-proxy configuration, or process-manager/container templates.
- Remote CI is still unproven because this checkout has no configured Git remote.
