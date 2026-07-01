# Milestone 039 Plan: RSC-Style Server Payload Stream

## Goal

Build the first explicit server payload stream on top of the validated client-reference transport, so server-rendered output can carry module references and resolved chunks as protocol data rather than only final HTML plus island attributes.

## Scope

- Define a Rust-owned server payload marker, version, chunk shape, and validation rules.
- Generate the TypeScript protocol mirror for the new payload shape.
- Emit a server payload from the TypeScript server facade for routes with imported client references.
- Preserve current HTML rendering, client-reference hydration, and production build behavior.
- Add normal, malformed, and compatibility tests across Rust protocol and TypeScript runtime/server paths.

## Out Of Scope

- Flight wire-format compatibility.
- Arbitrary async module graph execution in Rust.
- Server actions.
- Production cache hashing, compression, or observability.

## Required Proof

- Focused Rust protocol tests for server payload validation.
- Focused TypeScript runtime/server tests for payload emission and malformed payload rejection.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
