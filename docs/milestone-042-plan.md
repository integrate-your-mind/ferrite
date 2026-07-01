# Milestone 042 Plan: Server Payload Navigation Integration

## Goal

Add a small client-side navigation or refresh integration that uses server-payload responses for same-origin route changes while keeping full-page HTML navigation as the fallback.

## Scope

- Add a browser helper that owns a mounted root and applies server-payload responses for same-origin paths.
- Preserve normal browser navigation for external links, downloads, modifier-key clicks, and failed payload fetches.
- Update route-root attributes after payload navigation.
- Keep imported-client island hydration explicit and compatible with emitted client-reference chunks.
- Add deterministic tests for successful navigation, failed payload fallback behavior, external-link bypass, and malformed payload rollback.

## Out Of Scope

- Streaming incremental payload application.
- Prefetching.
- History state restoration beyond a minimal push/replace path.
- Server actions.
- Flight wire-format compatibility.

## Required Proof

- Focused runtime tests for navigation success and failure paths.
- Focused runtime tests for odd link cases that must bypass payload navigation.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
