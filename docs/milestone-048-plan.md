# Milestone 048 Plan: Navigator Stream-Mode Selection

## Goal

Let the browser payload navigator choose the HTTP server-payload stream endpoint when incremental application is available, while keeping the existing JSON packet path as a conservative fallback.

## Scope

- Add a navigator option for stream-frame navigation mode.
- Route stream-mode fetches to `?__ferrite_payload=stream`.
- Apply stream responses through `fetchAndApplyServerPayloadStream()`.
- Fall back to full JSON payload navigation when streams are unavailable or disabled.
- Preserve existing same-origin, modifier-key, target, download, and history guards.
- Add tests for normal stream navigation, stream failure fallback, prefetch interactions, and popstate restoration behavior.

## Out Of Scope

- Flight wire-format compatibility.
- Server actions.
- Scroll restoration.
- Compression or production cache strategy changes.

## Required Proof

- Focused runtime tests for stream-mode navigator behavior and JSON fallback.
- Existing payload navigation, prefetch, managed-head, and popstate tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
