# Milestone 054 Proof: Production Observability And Render Timeouts

## Changed

- Added optional command timeouts to the Rust page renderer subprocess runner.
- Wired production rendering to a clamped per-render timeout with a default of 30 seconds.
- Mapped production renderer timeouts to `504 Gateway Timeout` while preserving existing render failures as `500`.
- Added production request observer hooks that record method, path, status, route pattern, and elapsed duration.
- Exposed `ferrite serve --render-timeout-ms` and included the effective render timeout in JSON serve output.
- Updated architecture and README docs to reflect the new production frontier.

## Why

Production serving could already bound request reads and in-flight sockets, but a route render could still hang inside the Node page renderer with no explicit timeout or request outcome signal. This milestone puts the timeout at the subprocess boundary and adds a Rust observer hook for production request outcomes.

## Proof

- `cargo fmt --all && cargo test -p ferrite-page-renderer -p ferrite-dev-server -p ferrite-cli`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`
- `cargo run -p ferrite-cli -- --json serve --project examples/basic --once --render-timeout-ms 30000 --request-path /posts/abc | rg '"render_timeout_ms"|"status"|"route_pattern"'`
- `cargo run -p ferrite-cli -- --json serve --project examples/basic --once --render-timeout-ms 0 --request-path /posts/abc | rg '"render_timeout_ms"|"status"|"route_pattern"'`

Focused coverage includes:

- Hanging renderer subprocesses are killed and reported as `PageRenderError::TimedOut`.
- Production config defaults and builders clamp render/request limits.
- Production route render timeouts return `504 Gateway Timeout` with `Cache-Control: no-store` and `X-Ferrite-Route-Pattern`.
- Production request observer hooks record successful route responses.
- `ferrite serve` accepts `--render-timeout-ms`.
- `ferrite serve --render-timeout-ms 30000 --json --once` returns `200` for the example route; `--render-timeout-ms 0` is clamped to `1` and can return `504` for that same route.

## Not Proven

- Full tracing/log backend integration is not implemented.
- Graceful shutdown orchestration is not implemented.
- Worker pool reuse is not implemented; production still uses capped per-request workers.
- Client bundler subprocess timeouts are not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
