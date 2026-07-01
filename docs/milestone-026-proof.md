# Milestone 026 Proof: Dev Streaming for Inline Suspense Routes

## What Changed

- Made the dev server render every matched HTML route through the stream-capable page renderer.
- Kept `DevResponse::streaming_html` backward-compatible: routes with no deferred chunks still collapse to ordinary buffered `Content-Length` responses.
- Updated dev-server renderer fixtures to support `--stream` and `--document-stream`.
- Added a TCP test proving a route without `loading.tsx` still uses chunked transfer when the renderer returns stream chunks.
- Verified the real `/stream-demo` example route returns its inline `Suspense` fallback shell plus replacement chunk through `ferrite dev --once`.

## Why

Milestone 025 connected route `loading.tsx` streams to real HTTP chunking, but inline `Suspense` routes still needed to opt into streaming through a loading convention. Ferrite's dev server should treat the render-stream contract as the normal route render path and decide buffering versus chunking based on whether chunks actually exist.

## Verification

- `cargo test -p ferrite-dev-server`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /stream-demo`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: routes with no deferred chunks still send `Content-Length` over real HTTP.
- Stream path: inline stream chunks without a `loading.tsx` file send `Transfer-Encoding: chunked`.
- Loading path: route-level `loading.tsx` streams continue to send chunked HTTP.
- Failure path: page render, metadata, and client bundle failure tests still report their original errors after the stream-first change.
- Document path: `--document-stream` fixtures preserve custom document output for routes with no chunks.

## Not Yet Proven

- Production build remains static final HTML and does not expose an HTTP streaming adapter.
- Stream chunk writes are synchronous `TcpStream` writes without async backpressure handling.
- Browser-side async client component rendering is still intentionally unsupported.
