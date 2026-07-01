# Milestone 041 Plan: Browser Server Payload Application

## Goal

Add a browser-side path that fetches a server-payload response and applies the shell/chunk output to a mounted route root without replacing the existing HTML default.

## Scope

- Add TypeScript runtime helpers for fetching and validating server-payload route responses.
- Convert compact server-payload shell and chunk nodes into DOM updates through existing renderer primitives where possible.
- Keep imported-client island payload validation intact when payload HTML contains client-reference containers.
- Add deterministic tests for successful route refresh, malformed payload rejection, and missing-route/fetch failure handling.
- Keep the HTTP adapter protocol surface unchanged.

## Out Of Scope

- Flight wire-format compatibility.
- Server actions.
- Client-side router prefetching.
- Streaming incremental browser application over the network.
- Production cache hashing or compression.

## Required Proof

- Focused runtime tests for payload validation, DOM application, and failure behavior.
- Focused adapter/runtime integration test using a payload response fixture.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
