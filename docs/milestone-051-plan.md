# Milestone 051 Plan: Production Asset Preload Hints

## Goal

Emit production HTML preload hints for generated client assets so browsers can discover hashed route and island code earlier without changing runtime semantics.

## Scope

- Add modulepreload tags for production route and client-reference scripts.
- Preserve stylesheet tags as the render-blocking CSS mechanism.
- Deduplicate preload hints across route bundles and client references.
- Keep dev reload HTML behavior unchanged.
- Add tests for static build HTML and production server HTML.

## Out Of Scope

- CDN integration.
- HTTP `Link` headers.
- CSS preload or async stylesheet loading.
- Asset manifest signing.
- Flight wire-format compatibility.
- Server actions.

## Required Proof

- Focused builder/dev-server tests for modulepreload hints.
- Existing static asset fingerprinting and cache tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
