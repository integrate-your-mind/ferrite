# Milestone 045 Proof: Payload Prefetching For Navigation

## Changed

- Added `navigator.prefetch(input)` for same-origin server-payload prefetching.
- Added opt-in `prefetch: true` intent handling for safe same-origin anchors on pointer/focus events.
- Cached validated prefetched payload packets by normalized route URL.
- Consumed prefetched packets once through the same route-root, managed-head, root-update, and history-update path as ordinary navigation.
- Evicted failed or malformed prefetch requests without mutating DOM, head, or history.
- Ignored external, download, target, hash-only, and cross-origin prefetch targets.

## Why

Milestone 044 made activated payload navigation coherent across browser history. Prefetching reduces activation latency while keeping the mutation boundary unchanged: fetched packets are only applied when navigation actually occurs.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Explicit prefetch fetches once and later navigation consumes the cached packet without a second request.
- Focus intent prefetches safe same-origin links and click navigation consumes the prefetched packet.
- Failed prefetches reject, evict cache state, and allow a later successful navigation fetch.
- Malformed prefetches reject, evict cache state, and allow a later successful navigation fetch.
- Bypassed links and cross-origin URLs do not prefetch.

## Not Proven

- Incremental network streaming is not implemented.
- Scroll restoration is not implemented.
- The payload format is not Flight-compatible.
