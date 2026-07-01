# Milestone 027 Proof: Native Render Protocol Crate

## What Changed

- Added a new `ferrite-protocol` Rust crate to the workspace.
- Moved render-packet and render-stream markers, version constants, compact node shapes, packet structs, chunk structs, serializable prop values, and validation helpers into `ferrite-protocol`.
- Updated `ferrite-ssr` to consume and re-export the protocol types, preserving downstream Rust API compatibility.
- Kept `SsrError::InvalidRenderPacket` behavior stable by converting protocol validation errors into the existing SSR error variant.
- Added protocol-level tests for marker/version validation, stream chunk ids, and ferrite payload detection.

## Why

The render packet contract was embedded inside SSR. A native or WASM boundary needs the protocol to stand on its own: SSR should render packets, but it should not be the owner of packet versioning or validation. This slice creates that ownership boundary without changing emitted JSON or HTML behavior.

## Verification

- `cargo test -p ferrite-protocol -p ferrite-ssr`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: valid render packets and stream packets validate in the protocol crate and still render through SSR.
- Failure path: bad markers, unsupported versions, bad compact node opcodes, and invalid chunk ids still fail as `invalid render packet`.
- Compatibility path: `ferrite-ssr` re-exports protocol types so current Rust call sites do not need to import the new crate directly.

## Not Yet Proven

- TypeScript protocol types are still a manual mirror of the Rust protocol crate.
- There is no generated binding package or WASM module yet.
- The protocol crate owns packet validation, not Rust-side TSX execution or browser hydration.
