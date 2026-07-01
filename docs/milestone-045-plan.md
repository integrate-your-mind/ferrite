# Milestone 045 Plan: Payload Prefetching For Navigation

## Goal

Prefetch validated server-payload packets for safe same-origin navigation targets before activation, then consume the prefetched packet during click navigation when it is still valid.

## Scope

- Add an opt-in navigator prefetch API for URLs.
- Optionally prefetch safe same-origin anchors from pointer or focus intent.
- Reuse `serverPayloadRequestUrl()` and `validateServerPayloadPacket()` for prefetched responses.
- Cache successful packets by normalized same-origin route URL.
- Consume prefetched packets through the same route-root, managed-head, root-update, and history-update path as ordinary navigation.
- Evict failed or malformed prefetches without mutating the current DOM.
- Keep direct navigation fallback behavior unchanged when no usable prefetch exists.

## Out Of Scope

- Incremental network streaming.
- Scroll restoration.
- Server actions.
- Flight wire-format compatibility.
- Cross-origin or unsafe-method prefetching.

## Required Proof

- Focused runtime tests for explicit prefetch and click consumption.
- Focused runtime tests for malformed/failed prefetch eviction with no DOM mutation.
- Focused runtime tests proving bypassed links are not prefetched.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
