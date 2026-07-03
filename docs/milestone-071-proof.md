# Milestone 071: WASM Stream-Frame Validation

Date: 2026-07-03

## What Changed

- `ferrite-protocol-wasm` now exports `ferrite_validate_server_payload_stream_frame_json`.
- The Rust WASM crate validates both `server-payload-frame` shell frames and chunk frames through the existing `ferrite-protocol` validators.
- `@ferrite/protocol-wasm` now exposes `validateServerPayloadStreamFrameJson()` and typed `validateServerPayloadStreamFrame()` helpers alongside the existing full-packet helpers.

## Proof

- `cargo fmt --all`: passed.
- `cargo test -p ferrite-protocol-wasm`: passed 5 Rust tests.
- `pnpm --filter @ferrite/protocol-wasm test`: passed 6 package tests, including shell-frame success, chunk-frame success, and invalid chunk-id failure through Rust WASM.

## Remaining Gaps

- The package can validate stream frames when called directly, but Ferrite does not yet bundle or use `@ferrite/protocol-wasm` automatically from generated browser route assets.
- This does not change the DOM runtime's default TypeScript validation path for payload navigation or stream-frame application.
