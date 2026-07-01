# Milestone 044 Plan: Popstate Payload Restoration

## Goal

Restore payload-navigated routes when the browser back or forward buttons fire `popstate`, without replacing normal full-page fallback behavior.

## Scope

- Store enough history state during successful payload navigation to request the same server-payload URL later.
- Listen for `popstate` in the server-payload navigator.
- Fetch, validate, and apply the payload for same-origin restored entries.
- Reconcile managed document head nodes on restoration.
- Preserve no-mutation behavior for malformed restoration payloads.
- Keep fallback behavior explicit for failed restoration requests.

## Out Of Scope

- Prefetching.
- Streaming incremental payload application.
- Scroll restoration.
- Server actions.
- Flight wire-format compatibility.

## Required Proof

- Focused runtime tests for back/forward payload restoration.
- Focused runtime tests for restoration failure behavior and malformed payload rollback.
- Focused runtime tests proving unrelated external history entries are ignored.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
