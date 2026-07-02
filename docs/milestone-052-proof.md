# Milestone 052 Proof: Production Link Preload Headers

## Changed

- Added response metadata support for HTTP `Link` headers.
- Attached `Link: <...>; rel=modulepreload; as=script` headers to production HTML route responses.
- Reused the same deduplicated client script set used for production HTML `modulepreload` tags.
- Preserved dev responses, static asset responses, server-payload responses, and gzip/chunked transfer behavior.
- Updated the architecture note to reflect immutable production assets, preload hints, and Link headers.

## Why

Milestone 051 emitted `modulepreload` tags in production HTML, but real HTTP clients could not see those hints until parsing the document. This milestone mirrors the same hashed script hints in HTTP metadata without changing route bodies or payload transport semantics.

## Proof

- `cargo fmt --all && cargo test -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Direct production adapter responses carry modulepreload `Link` metadata for hashed route scripts.
- Raw uncompressed production HTML socket responses include matching `Link` headers.
- Raw gzip-compressed production HTML socket responses include matching `Link` headers while preserving `Content-Encoding: gzip`, `Vary: Accept-Encoding`, and `Content-Length`.
- Raw chunked production HTML stream responses include matching `Link` headers while preserving `Transfer-Encoding: chunked`.
- Production server-payload JSON responses do not emit route asset `Link` headers.
- Generated and manual static asset responses do not inherit route preload headers.

## Not Proven

- HTTP/2 server push is not implemented.
- CSS preload headers are not implemented.
- CDN integration is not implemented.
- Asset manifest signing is not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
