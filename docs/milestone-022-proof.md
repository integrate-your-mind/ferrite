# Milestone 022 Proof: Versioned Render Packet Bridge

## What Changed

- Added `CompactNode`, `RenderPacket`, `toRenderPacket`, and `serializableNodeToRenderPacket` to `@ferrite/runtime`.
- Added `renderPageModuleToPacket` and `renderDocumentModuleToPacket` to `@ferrite/runtime/server`.
- Updated `packages/runtime/bin/render-page.mjs` so render and document modes emit versioned compact render packets.
- Updated `ferrite-ssr` to accept both the existing legacy serialized VNode JSON and the new `{ ferrite: "render-packet", version: 1, root }` packet.
- Added page-renderer coverage for packet-emitting runner output while preserving legacy JSON page/document tests.
- Updated architecture and README docs so the completed bridge milestone no longer remains as the next roadmap item.

## Why

The original bridge sent verbose tagged objects for every SSR node. The new packet keeps the contract explicit and versioned while using compact array nodes:

- `[0, text]` for text
- `[1, children]` for fragments
- `[2, tag, props, children]` for elements

This is still JSON for debuggability, but it is a better stepping stone toward a native or WASM boundary because the shape is stable, smaller, and owned by Rust validation.

## Verification

- `cargo test -p ferrite-ssr -p ferrite-page-renderer`
- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: packet SSR renders escaped HTML and page-renderer packet output renders through Rust.
- Backward compatibility path: legacy serialized VNode JSON still renders through the CLI/SSR parser and page-renderer tests.
- Failure path: bad packet marker, unsupported packet version, wrong compact-node opcode, page runner failures, and unserializable JS props reject.
- Odd path: empty JS output becomes an empty fragment packet.
- Runtime path: `packages/runtime/bin/render-page.mjs` emits `{ "ferrite": "render-packet", "version": 1, "root": ... }`.
- Build artifact path: `examples/basic/.ferrite/build/index.html` includes the expected route HTML, Open Graph tags, icon link, canonical link, stylesheet, and client script.

## Not Yet Proven

- The bridge is compact and versioned, but it is still JSON over a Node process boundary; no native/WASM ABI has been implemented yet.
- Streaming server output and Suspense-style async boundaries are not implemented yet.
- This workspace is not a Git repository, so PR status and CI status could not be checked from here.
