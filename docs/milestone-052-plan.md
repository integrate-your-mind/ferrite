# Milestone 052 Plan: Production Link Preload Headers

## Goal

Expose production script preload hints through HTTP `Link` headers so adapters can advertise the same hashed module scripts already present in production HTML.

## Scope

- Add response metadata support for one or more `Link` headers.
- Attach `rel=modulepreload` `Link` headers to production HTML route responses.
- Reuse the same deduplicated script set used by production `modulepreload` HTML tags.
- Preserve existing dev response behavior, static asset responses, payload responses, and compression semantics.
- Add socket-level tests for normal, gzip, and chunked production responses where relevant.

## Out Of Scope

- HTTP/2 server push.
- CSS preload headers.
- CDN integration.
- Asset manifest signing.
- Flight wire-format compatibility.
- Server actions.

## Required Proof

- Focused dev-server tests for production `Link` headers.
- Existing compression, chunked transfer, static asset cache, and modulepreload tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
