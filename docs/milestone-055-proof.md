# Milestone 055 Proof: Production Worker Pool And Shutdown

## Changed

- Added a cloneable production shutdown controller/signal pair.
- Replaced the long-running production per-request thread spawn path with a reusable worker pool sized by `max_in_flight_requests`.
- Added `serve_production_listener_with_shutdown()` for embedders and tests.
- Kept `serve_production_listener_once()` as the deterministic single-request path.
- Added nonblocking accept polling so shutdown stops new accepts and then drains accepted work before returning.
- Updated architecture and README docs to move the production-serving frontier forward.

## Why

Production serving had request bounds, render timeouts, and observer hooks, but the long-running socket loop still created a thread for every accepted request and had no controlled return path. This milestone makes the production listener reusable in embedded contexts and avoids unbounded thread creation.

## Proof

- `cargo fmt --all && cargo test -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Worker pool sizing clamps empty worker counts to one worker.
- The shutdown-aware pooled listener serves multiple real HTTP requests.
- Shutdown requested while a render is in progress stops new accepts and still drains the accepted request.
- Existing production response, timeout, compression, cache-control, static asset, and preload tests remain green.

## Not Proven

- OS signal handling in the CLI is not implemented.
- Async runtime integration is not implemented.
- Hot config reload is not implemented.
- Client bundler subprocess timeouts are not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
