# Milestone 046 Plan: Incremental Payload Streaming

## Goal

Apply server-payload navigation from an incremental network stream so route shells can commit before all deferred chunks have arrived.

## Scope

- Define a browser-readable incremental payload framing contract that remains versioned and validated.
- Add a fetch helper that can parse shell-first and chunk frames from a response body.
- Apply the shell through the existing route-root and managed-head path.
- Apply later chunk frames into matching suspense boundaries without replacing unrelated DOM.
- Preserve rollback/no-mutation behavior for malformed shell frames.
- Fail closed for malformed or unmatched chunk frames after shell commit with an explicit error path.

## Out Of Scope

- Flight wire-format compatibility.
- Server actions.
- Scroll restoration.
- WASM/native package distribution.

## Required Proof

- Focused runtime tests for shell-first application followed by deferred chunk insertion.
- Focused runtime tests for malformed shell rollback before mutation.
- Focused runtime tests for malformed or unmatched chunk failure after shell commit.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
