# Milestone 040 Plan: Server Payload HTTP Surfaces

## Goal

Expose the validated server payload stream through development and production HTTP adapters so clients and tests can request protocol data directly instead of only HTML.

## Scope

- Add a dev HTTP route for requesting server payload output for a matched app route.
- Add a production HTTP route or negotiated request mode for server payload output.
- Preserve existing HTML, stream, and static asset behavior.
- Return clear errors for unknown routes, invalid request paths, and page render failures.
- Add CLI or `--once` proof paths where useful for deterministic verification.

## Out Of Scope

- Flight wire-format compatibility.
- Browser-side payload application.
- Server actions.
- Production cache hashing or compression.

## Required Proof

- Focused Rust dev-server/page-renderer tests for server payload responses.
- Focused CLI or adapter tests for normal, missing-route, and render-failure paths.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
