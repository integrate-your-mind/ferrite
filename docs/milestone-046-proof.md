# Milestone 046 Proof: Incremental Payload Streaming

## Changed

- Added a Rust-owned `server-payload-frame` protocol marker and version.
- Added Rust validation for shell and chunk stream frames.
- Regenerated the TypeScript protocol mirror with stream frame types and `validateServerPayloadStreamFrame()`.
- Added `fetchAndApplyServerPayloadStream()` in `@ferrite/runtime/dom`.
- Parsed line-delimited JSON frames from readable response bodies.
- Committed validated shell frames before deferred chunks arrive.
- Applied later chunk frames through the same route-root, managed-head, compact-node, and suspense-boundary path as full payload application.
- Preserved no-mutation behavior for malformed shell frames.
- Failed closed for chunk-before-shell, unmatched chunk, and invalid JSON after shell commit.

## Why

Milestone 045 reduced navigation activation latency with prefetching, but payload application still required a complete packet before any route shell could commit. This milestone adds the browser/protocol half of incremental payload streaming so a valid shell can render before deferred chunks finish.

## Proof

- `cargo test -p ferrite-protocol`
- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Rust validation for valid shell/chunk frames and marker/version/kind/chunk-id failures.
- Runtime shell-first commit followed by deferred chunk insertion.
- Malformed shell rollback before route DOM or head DOM mutation.
- Chunk-before-shell rejection without mutation.
- Unmatched chunk failure after shell commit with the shell left in place.
- Invalid JSON failure after shell commit with the shell left in place.

## Not Proven

- Dev and production HTTP adapters do not yet serve framed payload streams.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
- Scroll restoration is not implemented.
