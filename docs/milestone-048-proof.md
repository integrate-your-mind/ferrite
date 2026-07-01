# Milestone 048 Proof: Navigator Stream-Mode Selection

## Changed

- Added an explicit `serverPayloadRequestUrl(input, mode)` request mode.
- Added `serverPayloadStreamRequestUrl()` for the frame-stream endpoint.
- Fixed `fetchAndApplyServerPayloadStream()` to request `?__ferrite_payload=stream`.
- Added `stream: true` navigator mode for route navigation and popstate restoration.
- Kept explicit prefetch on the complete JSON packet path so prefetched packets remain reusable.
- Added JSON fallback when stream responses fail before a shell is committed.
- Guarded async stream updates so destroyed navigators do not mutate through delayed stream commits.

## Why

Milestone 047 exposed framed payload streams over HTTP, but the browser navigator still only used the full JSON endpoint. This milestone lets route navigation use the stream endpoint without breaking the existing JSON default or prefetch cache behavior.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- URL helpers for `server` and `stream` payload modes.
- Direct stream application requesting `?__ferrite_payload=stream`.
- Navigator stream mode committing a shell before chunks and updating history after completion.
- JSON fallback when a stream body is unavailable before shell commit.
- Stream mode consuming an existing JSON prefetch without a second request.
- Popstate restoration through the stream endpoint.

## Not Proven

- The stream mode is opt-in; adaptive default selection is not implemented.
- Production compression is not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
- Scroll restoration is not implemented.
