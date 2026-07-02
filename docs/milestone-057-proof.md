# Milestone 057 Proof: Native Prebuild Resolution

## Changed

- Added `packages/node/binding.js` to resolve the native Node binding from an explicit `FERRITE_NODE_BINDING`, a local source-build artifact, or a supported optional platform prebuild package.
- Kept `@ferrite/node` source-build behavior intact by preferring `dist/ferrite-node.node` before optional platform packages.
- Added `packages/node/scripts/create-prebuild-package.mjs` to generate a platform package directory with `ferrite-node.node`, `os`/`cpu` constraints, and an export for the native artifact.
- Expanded `@ferrite/node` tests to cover override, missing override, local source-build priority, optional prebuild fallback, unsupported platform errors, and missing optional package candidates.
- Updated README and architecture docs to describe source-build and optional-prebuild native resolution without claiming release automation is done.

## Why

Ferrite already had a native Node addon, but JavaScript consumers could only load a locally copied build artifact. Optional platform-package resolution is the next production-shaped step toward prebuilt native distribution while keeping local development deterministic.

## Proof

- `pnpm --filter @ferrite/node typecheck`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Focused Coverage

- Normal path: `@ferrite/node` still loads the local `dist/ferrite-node.node` after `pnpm --filter @ferrite/node build`.
- Failure path: a missing explicit `FERRITE_NODE_BINDING` fails without falling back to a different binding.
- Odd path: unsupported platforms report that no optional prebuild package mapping exists.
- Distribution path: when local `dist` is absent and an optional package resolves to `ferrite-node.node`, the resolver chooses the prebuilt package path.
- Packaging path: `pnpm --filter @ferrite/node prebuild:package` generated an ignored local package for `@ferrite/node-darwin-arm64` with `os`, `cpu`, `files`, and native artifact export metadata.

## Not Proven

- Published platform packages.
- Multi-platform CI release automation.
- Code-signing, notarization, or checksum verification.
- WASM bindings.
- Flight-compatible React Server Components.
