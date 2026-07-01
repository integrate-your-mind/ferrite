# Milestone 044 Proof: Popstate Payload Restoration

## Changed

- Marked payload-navigation history entries with the server-payload URL needed for restoration.
- Seeded the current history entry so the first back navigation can restore the original route through payload JSON.
- Added `popstate` handling for framework-marked same-origin entries.
- Reused the same payload fetch, protocol validation, route-root extraction, root update, and managed head reconciliation path used by direct navigation.
- Added fallback behavior for failed restored payload requests.
- Ignored external history entries without Ferrite payload-navigation state.

## Why

Milestone 043 made link-initiated payload navigation update the route root and managed document head, but browser back/forward still left the URL and DOM contract incomplete. Restoring marked history entries keeps the payload navigator coherent across normal browser navigation without taking over unrelated history state.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Back and forward navigation restore route DOM and managed head state from server payloads.
- Restored payload request failures call the configured fallback and leave the current DOM/head unchanged.
- Malformed restored payloads reject before route DOM or head DOM mutation.
- Popstate entries without Ferrite history state are ignored without fetches or fallback calls.

## Not Proven

- Payload prefetching is not implemented.
- Payload application remains full-response only, not incremental network streaming.
- Scroll restoration is not implemented.
- The payload format is not Flight-compatible.
