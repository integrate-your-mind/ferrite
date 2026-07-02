# Milestone 053 Proof: Production Request Hardening

## Changed

- Added production server defaults for request read timeout, maximum request header bytes, and maximum in-flight request workers.
- Moved owned `ferrite serve` production sockets onto a bounded worker loop.
- Kept deterministic one-request production listener helpers for tests.
- Added bounded production request reading with explicit `408 Request Timeout` and `413 Payload Too Large` responses.
- Added an internal in-flight limiter with release-on-drop behavior.
- Updated architecture docs to describe bounded production request handling.

## Why

Production serving had real HTTP, compression, hashed assets, and preload metadata, but the long-running listener still accepted requests through an unbounded blocking read path. This milestone adds the first defensive limits around socket request handling without changing route rendering semantics.

## Proof

- `cargo fmt --all && cargo test -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Production hardening defaults are bounded.
- Production config builders clamp empty request limits.
- The in-flight limiter refuses permits at capacity and releases capacity on drop.
- Oversized production request headers return `413 Payload Too Large`.
- Silent production sockets time out with `408 Request Timeout`.
- Existing production HTML, compression, chunked transfer, static asset cache, and preload header tests remain green.

## Not Proven

- Per-route render execution timeout is not implemented.
- Worker pool reuse is not implemented; the owned production listener uses capped per-request workers.
- Graceful shutdown orchestration is not implemented.
- Observability hooks are not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
