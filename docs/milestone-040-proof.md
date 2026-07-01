# Milestone 040 Proof: Server Payload HTTP Surfaces

## Changed

- Added validated raw server-payload JSON methods to `ferrite-page-renderer` for page and document render modes.
- Added `?__ferrite_payload=server` negotiation to development and production route adapters.
- Added a Ferrite server-payload content type for protocol JSON responses.
- Preserved existing HTML behavior as the default route response.
- Kept production `Cache-Control: no-store` and `X-Ferrite-Route-Pattern` metadata on route payload responses.
- Added adapter tests for normal payload responses, custom document payload responses, missing routes, unsupported reserved query values, render failures, and real socket responses.

## Why

Milestone 039 created a Rust-owned server-payload protocol but only used it behind the page-renderer boundary. This milestone exposes the same validated protocol packets through the framework HTTP adapters, making server-payload data requestable without replacing normal HTML responses.

## Proof

- `cargo fmt --all && cargo test -p ferrite-page-renderer -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path '/posts/abc?__ferrite_payload=server'`
- `cargo run -p ferrite-cli -- serve --project examples/basic --once --request-path '/posts/abc?__ferrite_payload=server'`

Focused coverage includes:

- Rust page-renderer raw JSON methods validate server-payload packets before returning them.
- Dev adapter returns route payload JSON with `?__ferrite_payload=server`.
- Dev adapter returns document payload JSON when `app/document.tsx` exists.
- Production adapter returns payload JSON with production cache and route metadata.
- Unknown routes keep returning a 404.
- Unsupported `__ferrite_payload` values fail with `400 Bad Request`.
- Page-renderer failures in payload mode return 500 error pages.
- A real HTTP socket request returns `Content-Length` protocol JSON instead of chunked HTML.
- CLI `dev --once` and `serve --once` return server-payload protocol JSON for the example dynamic route.

## Not Proven

- Browser runtime application of server-payload responses is not implemented.
- The payload format is not Flight-compatible.
- Server actions and mutation transport are not implemented.
- Compression, hashed caching, and production observability are not implemented.
