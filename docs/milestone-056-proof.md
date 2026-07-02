# Milestone 056 Proof: Browser-Safe Protocol Package

## Changed

- Added `@ferrite/protocol` as a dedicated workspace package with its own build, typecheck, generated-source check, and Node test suite.
- Moved the Rust-generated TypeScript protocol mirror from `packages/runtime/src/protocol.ts` to `packages/protocol/src/index.ts`.
- Kept `@ferrite/runtime` backward compatible by re-exporting the protocol package from `packages/runtime/src/protocol.ts` and the existing runtime root exports.
- Updated the Rust generated-source test to read the new protocol package source.
- Updated workspace scripts and lockfile so protocol build/test/typecheck runs before runtime work that depends on it.
- Updated README and architecture docs to treat the protocol as a browser-safe package boundary.

## Why

The protocol boundary is Rust-owned but consumed by JavaScript/TypeScript on both server and browser paths. Splitting it into `@ferrite/protocol` makes that contract independently buildable, typecheckable, and testable without pulling in DOM runtime helpers or native Node bindings.

## Proof

- `cargo test -p ferrite-protocol`
- `pnpm --filter @ferrite/protocol test`
- `pnpm --filter @ferrite/runtime typecheck`
- `pnpm --filter @ferrite/runtime test`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Focused Coverage

- Normal path: `createClientReferencePayload()` builds a valid versioned payload and `validateServerPayloadPacket()` accepts a payload with shell references and chunks.
- Failure path: malformed client reference modules, non-JSON props, bad stream chunk ids, and empty chunk ids throw clear validation errors.
- Odd path: `@ferrite/runtime` keeps compiling and testing through the compatibility re-export while its protocol implementation now lives in a separate package.
- Drift path: both Rust unit tests and the package `check:generated` script compare `packages/protocol/src/index.ts` against `ferrite-protocol-codegen`.

## Not Proven

- npm publication.
- WASM bindings for Rust-side protocol validation.
- Prebuilt native package release automation.
- Flight-compatible React Server Components.
- Server actions.
