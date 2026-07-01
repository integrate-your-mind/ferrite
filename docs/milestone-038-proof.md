# Milestone 038 Proof: Versioned Client Reference Transport

## Changed

- Added Rust-owned client-reference protocol markers, versioning, payload types, and validation.
- Regenerated the TypeScript protocol mirror with client-reference payload helpers.
- Made `createClientReference()` emit a versioned `data-ferrite-client-payload` while preserving legacy props attributes.
- Made `hydrateClientReference()` validate versioned payloads and fall back to legacy props for compatibility.
- Made the Rust client bundler reject malformed JS-produced client-reference manifest entries.
- Hardened the runtime test scheduler helper to drain the scheduler's one-transition-task-per-turn host model.

## Why

Imported `"use client"` islands worked, but the transport was still an ad hoc pair of HTML attributes. This milestone makes the boundary explicit and versioned, with Rust protocol ownership and TypeScript helpers generated from that source. It is a prerequisite for moving toward a real RSC-style server/client payload stream.

## Proof

- `cargo fmt --all && cargo test -p ferrite-protocol -p ferrite-client-bundler && pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Valid client-reference payloads for `default`, named, and namespace-style exports.
- Invalid markers, versions, module paths, export names, and id/module/export mismatches.
- TypeScript protocol mirror drift detection from Rust codegen.
- Server-emitted versioned payloads for imported-client islands.
- Browser hydration using the versioned payload ahead of legacy props.
- Browser hydration rejection for payload id mismatches.
- Rust bundler rejection of malformed client-reference manifest output.

## Not Proven

- This is not a Flight-compatible transport.
- This does not execute React Server Components.
- This does not add WASM or prebuilt native distribution.
