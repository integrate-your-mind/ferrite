# Milestone 043 Plan: Head Reconciliation For Payload Navigation

## Goal

Reconcile document head and framework-managed resource changes when server-payload navigation receives a document-shaped payload.

## Scope

- Extract `<head>` from document-shaped server payloads during navigation.
- Update `document.title` and framework-managed meta/link/script tags deterministically.
- Preserve unrelated user-authored or third-party head nodes where possible.
- Ensure route client-reference scripts/styles from payload documents are installed or retained before island hydration runs.
- Add rollback or no-mutation behavior for malformed head payloads.

## Out Of Scope

- Streaming incremental payload application.
- Prefetching.
- Full popstate restoration.
- Server actions.
- Flight wire-format compatibility.

## Required Proof

- Focused runtime tests for title/meta/link/script reconciliation.
- Focused runtime tests for preserving unrelated head nodes.
- Focused runtime tests for malformed head rollback.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
