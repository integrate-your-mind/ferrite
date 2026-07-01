# Milestone 039 Proof: Server Payload Stream

## Changed

- Added Rust-owned `server-payload` protocol marker, version, packet/chunk types, and validation.
- Regenerated the TypeScript protocol mirror with `ServerPayloadPacket`, `ServerPayloadChunk`, and `validateServerPayloadPacket()`.
- Added `renderPageModuleToServerPayload()` and `renderDocumentModuleToServerPayload()` in `@ferrite/runtime/server`.
- Added `--server-payload` and `--document-server-payload` modes to the TSX page runner.
- Added Rust SSR support for rendering validated server payload packets back to stream parts or concatenated HTML.
- Added Rust page-renderer APIs for page/document server payload output.

## Why

Milestone 038 made imported-client islands explicit and versioned, but route output was still either HTML or render-stream packets. This milestone adds the first RSC-style protocol layer: a server payload that carries compact shell output, deferred chunks, and the client-reference payloads needed by each shell/chunk.

## Proof

- `cargo fmt --all && cargo test -p ferrite-protocol -p ferrite-ssr -p ferrite-page-renderer && pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Rust validation for server payload marker/version, chunk ids, and nested client-reference payloads.
- Rust SSR rendering of server payload packets to stream HTML.
- Rust page-renderer request paths for page and document server payloads.
- TypeScript server payload emission for shell client references.
- TypeScript server payload emission for client references inside deferred stream chunks.
- TypeScript render-page integration for imported `"use client"` module proxies.
- Malformed embedded client-reference payload rejection.

## Not Proven

- Server payload responses are not exposed through dev or production HTTP endpoints yet.
- The format is not Flight-compatible.
- Server actions and mutation transport are not implemented.
