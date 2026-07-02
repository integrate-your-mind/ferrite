# Milestone 056 Plan: Browser-Safe Protocol Package

Goal: split the Rust-generated TypeScript protocol mirror into a dedicated `@ferrite/protocol` package that can be consumed by browser and server JavaScript without depending on the full runtime package.

Scope:

- Move the generated TypeScript protocol source to `packages/protocol/src/index.ts`.
- Keep Rust as the source of truth by checking `packages/protocol/src/index.ts` against `ferrite-protocol-codegen`.
- Preserve `@ferrite/runtime` compatibility by re-exporting protocol APIs from `packages/runtime/src/protocol.ts` and the root runtime entrypoint.
- Add package-level tests for normal protocol creation/validation, malformed client references, server-payload stream frames, and malformed chunks.
- Update workspace scripts so protocol build/test/typecheck runs before dependent runtime work.

Out of scope:

- Publishing to npm.
- WASM bindings for Rust validation.
- Prebuilt native package release automation.
- Flight-compatible server component transport.
- Server actions.
