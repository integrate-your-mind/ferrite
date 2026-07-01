# Milestone 047 Proof: HTTP Server-Payload Stream Frames

## Changed

- Added `?__ferrite_payload=stream` negotiation for dev and production route adapters.
- Added a dedicated `application/vnd.ferrite.server-payload-stream+jsonl` response content type.
- Converted validated server-payload packets into line-delimited shell/chunk frame responses.
- Preserved existing `?__ferrite_payload=server` JSON packet behavior.
- Preserved dev/prod cache-control and route-pattern response metadata.
- Added dev, production, custom-document, and real HTTP tests for framed server-payload responses.

## Why

Milestone 046 gave the browser runtime the ability to consume line-delimited server-payload frames, but framework HTTP routes still only exposed complete JSON packets. This milestone connects the Rust HTTP adapters to that frame contract so real route responses can commit a shell before deferred chunks finish.

## Proof

- `cargo test -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Dev route stream-frame responses.
- Dev custom-document stream-frame responses.
- Production route stream-frame responses.
- Real socket output with chunked transfer encoding and shell/chunk frame lines.
- Existing JSON payload response behavior remaining green.
- Unsupported reserved payload query values still returning `400 Bad Request`.

## Not Proven

- The browser navigator does not yet automatically request stream-frame mode.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
- Scroll restoration is not implemented.
