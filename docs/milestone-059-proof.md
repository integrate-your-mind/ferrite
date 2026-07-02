# Milestone 059 Proof: WASM Protocol Validation

## Changed

- Added `ferrite-protocol-wasm`, a Rust crate that compiles to `wasm32-unknown-unknown` and validates server-payload JSON through the Rust `ferrite-protocol` crate.
- Added a small WASM ABI for input allocation, server-payload validation, last-error reads, and cleanup.
- Added `@ferrite/protocol-wasm`, a TypeScript package that instantiates the WASM artifact and exposes `validateServerPayloadJson()` plus typed `validateServerPayload()` helpers.
- Added package build automation that copies `ferrite_protocol_wasm.wasm` into `packages/protocol-wasm/dist`.
- Updated workspace test/lint/build/typecheck scripts so the WASM package participates in normal gates.
- Updated README and architecture docs to describe Rust-backed browser-capable protocol validation.

## Why

Ferrite already had a browser-safe TypeScript protocol package, but validation still ran in TypeScript outside Rust for browser consumers. This milestone adds a real Rust-owned WASM validation path for server payloads while keeping the wrapper thin and typed.

## Proof

- `cargo test -p ferrite-protocol-wasm`
- `RUSTC=$(rustup which rustc) $(rustup which cargo) build -p ferrite-protocol-wasm --target wasm32-unknown-unknown`
- `pnpm --filter @ferrite/protocol-wasm typecheck`
- `pnpm --filter @ferrite/protocol-wasm test`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Focused Coverage

- Normal path: valid server-payload JSON passes through the Rust WASM validator.
- Typed path: `validateServerPayload()` returns the original typed payload after WASM validation.
- Failure path: invalid stream chunk ids throw the Rust protocol validation error.
- Odd path: malformed JSON throws a clear WASM-backed JSON parse error.
- Toolchain path: the WASM build script resolves rustup Cargo/Rustc together when available, avoiding the local Homebrew `cargo`/`rustc` target mismatch.

## Not Proven

- npm publication.
- Automatic bundler integration for app builds.
- Streaming payload validation through WASM.
- Full Flight-compatible React Server Components.
- Server actions.
