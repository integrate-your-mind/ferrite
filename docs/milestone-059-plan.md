# Milestone 059 Plan: WASM Protocol Validation

Goal: expose Rust-owned server-payload protocol validation through a browser-consumable WASM package.

Scope:

- Add a `ferrite-protocol-wasm` Rust crate that compiles to `wasm32-unknown-unknown`.
- Export a small WASM ABI for allocating input bytes, validating server-payload JSON, and reading validation errors.
- Add an `@ferrite/protocol-wasm` TypeScript package that instantiates the WASM module and exposes typed validation helpers.
- Add Rust unit tests for valid, malformed, and invalid payload JSON.
- Add Node tests that load the built `.wasm` artifact and exercise valid, invalid, and malformed payloads through the TypeScript wrapper.
- Wire the package into workspace test/lint/build/typecheck scripts.

Out of scope:

- npm publication.
- WASM bundler integration for app builds.
- Streaming payload validation.
- Full Flight-compatible server component transport.
- Server actions.
