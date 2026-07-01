# Milestone 028 Proof: TypeScript Protocol Mirror Validation

## What Changed

- Added `packages/runtime/src/protocol.ts` as the TypeScript-side render protocol mirror.
- Moved runtime protocol constants and packet types out of `index.ts` and re-exported them from the public runtime entrypoint.
- Updated runtime packet emission to use `RENDER_PACKET_MARKER`, `RENDER_PACKET_VERSION`, and compact-node opcode constants instead of inline literals.
- Added compact-node opcode constants to `ferrite-protocol`.
- Added a Rust protocol test that reads `packages/runtime/src/protocol.ts` and verifies marker, version, and opcode constants match the Rust protocol crate.
- Updated SSR compact-node decoding to use protocol opcode constants.

## Why

Milestone 027 made Rust the owner of the render protocol, but TypeScript still duplicated protocol constants in the runtime entrypoint. This milestone makes that duplication explicit, centralized, and tested from Rust so drift fails during `cargo test`.

## Verification

- `cargo test -p ferrite-protocol -p ferrite-ssr`
- `pnpm --filter @ferrite/runtime typecheck && pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: runtime render packets still emit the same marker, version, and compact opcodes.
- Failure path: changing TypeScript protocol constants away from Rust constants now fails the Rust protocol test.
- Compatibility path: `@ferrite/runtime` still re-exports protocol types and constants from the root entrypoint.

## Not Yet Proven

- The TypeScript mirror is validated, not generated.
- There is still no WASM package or native Node binding.
- Protocol validation does not cover every TypeScript type shape, only the stable marker/version/opcode constants.
