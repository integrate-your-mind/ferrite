# Milestone 029 Proof: Generated TypeScript Protocol Module

## What Changed

- Added `typescript_protocol_source()` to `ferrite-protocol`.
- Added `ferrite-protocol-codegen`, a Cargo binary that prints the generated TypeScript protocol module.
- Made `packages/runtime/src/protocol.ts` match the Rust-generated source exactly.
- Strengthened the protocol crate test from constant presence checks to byte-for-byte generated-source comparison.

## Why

Validation caught constant drift, but the TypeScript protocol module was still manually authored. This milestone moves ownership one step further into Rust: the protocol crate now generates the TypeScript mirror, and tests prove the checked-in runtime file is exactly that generated output.

## Verification

- `cargo run -p ferrite-protocol --bin ferrite-protocol-codegen`
- `cargo test -p ferrite-protocol -p ferrite-ssr`
- `pnpm --filter @ferrite/runtime typecheck && pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: runtime packet emission still uses generated protocol constants and passes runtime tests.
- Failure path: hand-editing `packages/runtime/src/protocol.ts` away from generated output fails the Rust protocol test.
- Tooling path: `ferrite-protocol-codegen` prints the exact TypeScript module source used by the runtime.

## Not Yet Proven

- The generator writes to stdout; there is no dedicated formatter or file-writing command yet.
- There is still no published WASM or native Node binding.
- Generated TypeScript covers the render protocol only, not app route types or RSC boundaries.
