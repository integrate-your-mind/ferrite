# Milestone 041 Proof: Browser Server Payload Application

## Changed

- Added `serverPayloadRequestUrl()` to negotiate `?__ferrite_payload=server` while preserving existing query strings and hashes.
- Added `fetchServerPayload()` to fetch route payload JSON and validate it with the generated protocol mirror.
- Added `serverPayloadToChild()` and `compactNodeToChild()` to convert compact protocol nodes back into Ferrite DOM children.
- Added `applyServerPayload()` and `fetchAndApplyServerPayload()` to update a mounted root through the existing DOM update path.
- Added full-payload chunk merging: returned chunks replace matching `data-ferrite-suspense-boundary` shell markers before the root is updated.
- Added failure checks for malformed compact nodes, duplicate/unmatched chunks, failed fetch responses, and invalid DOM-unsafe props.

## Why

Milestone 040 made server-payload responses available over HTTP, but the browser runtime could not consume them. This milestone adds the first browser-side application path without introducing a client router or incremental network streaming yet.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Request URL rewriting adds or replaces the payload query flag.
- A mounted root updates from a fetched server-payload shell.
- Deferred payload chunks replace matching Suspense boundary shell markers.
- Malformed compact nodes fail before DOM mutation.
- Chunks without matching shell boundaries fail before DOM mutation.
- Failed fetch responses fail before DOM mutation.

## Not Proven

- There is no client-side router or link interception yet.
- Payload application is full-response only, not incremental network streaming.
- Client-reference chunks are still hydrated by their emitted browser chunks; payload application does not auto-import missing client modules.
- The payload format is not Flight-compatible.
