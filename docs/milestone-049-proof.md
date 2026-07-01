# Milestone 049 Proof: Production Response Compression

## Changed

- Added `flate2` for conservative gzip response compression.
- Parsed `Accept-Encoding` for production HTTP sockets.
- Compressed eligible production HTML responses when gzip is accepted.
- Compressed production server-payload JSON responses when gzip is accepted.
- Compressed production line-delimited server-payload frame streams while preserving `Transfer-Encoding: chunked`.
- Added `Content-Encoding: gzip` and `Vary: Accept-Encoding` only when response bytes are compressed.
- Preserved uncompressed responses for clients that do not advertise gzip support.
- Kept dev-server response writing uncompressed for deterministic local checks.

## Why

Milestone 048 made the browser navigator able to consume framed payload streams, but production sockets still sent all text and payload responses uncompressed. This milestone adds a production-only compression layer without changing route rendering, payload semantics, or dev output.

## Proof

- `cargo test -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- `Accept-Encoding` gzip quality and wildcard parsing.
- Compressed production HTML with decoded body proof.
- Uncompressed production HTML for unsupported encodings.
- Compressed production server-payload JSON with decoded body proof.
- Compressed production server-payload frame streams with chunked transfer and decoded body proof.
- Existing real socket chunking tests remaining green.

## Not Proven

- Brotli is not implemented.
- Immutable hashed asset caching is not implemented.
- Production concurrency controls and observability hooks are not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
