# Milestone 049 Plan: Production Response Compression

## Goal

Add production-safe response compression for HTML, JSON server payloads, and line-delimited server-payload frame streams without changing route semantics.

## Scope

- Parse `Accept-Encoding` for production HTTP responses.
- Compress eligible text responses with a conservative gzip path.
- Preserve uncompressed responses when clients do not advertise support.
- Preserve `Transfer-Encoding: chunked` behavior for streamed shell/chunk bodies.
- Add `Vary: Accept-Encoding` where compression can change response bytes.
- Keep dev server responses uncompressed for deterministic local checks.
- Add tests for normal, unsupported, and streamed compression paths.

## Out Of Scope

- Brotli.
- CDN cache policy.
- Hashed immutable asset naming.
- Server actions.
- Flight wire-format compatibility.

## Required Proof

- Focused Rust production-adapter tests for compressed HTML, JSON payload, and frame-stream responses.
- Existing real socket chunking tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
