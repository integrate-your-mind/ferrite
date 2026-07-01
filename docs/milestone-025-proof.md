# Milestone 025 Proof: Chunked Dev HTTP for Route Loading Streams

## What Changed

- Added optional stream parts to `DevResponse` while preserving the buffered `body` used by tests and `ferrite dev --once`.
- Routed dev responses with a discovered `loading.tsx` through `render_page_to_stream_parts_with_conventions` or `render_document_to_stream_parts_with_conventions`.
- Added chunked HTTP writing for streamed dev responses: shell first, then each resolved stream chunk, then the terminating chunk.
- Kept ordinary dev responses on `Content-Length`.
- Updated the example `/route-loading` path so `--once` shows the fallback shell plus replacement chunk output.

## Why

Ferrite already had render-stream packets and route `loading.tsx` discovery. This milestone connects those pieces to the actual development HTTP path, so async route work can reach the browser as a shell and later replacement chunk instead of existing only as a direct render artifact.

## Verification

- `cargo test -p ferrite-dev-server`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /route-loading`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /route-error`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: a loading-convention route writes `Transfer-Encoding: chunked` over a real TCP request.
- Compatibility path: a non-loading route still writes `Content-Length` and no chunked header.
- Document path: the example route with `app/document.tsx` streams the document shell plus deferred replacement chunk.
- Buffered path: `DevResponse.body_text()` and `ferrite dev --once` still return deterministic full HTML for checks.

## Not Yet Proven

- Inline `Suspense` routes without a `loading.tsx` convention still use the buffered dev render path.
- Production static build still writes final resolved HTML, not streaming artifacts.
- Chunk flushing is sequential and synchronous through `TcpStream`; there is no async server runtime or backpressure-aware adapter yet.
