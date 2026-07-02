# Milestone 058 Proof: Native Prebuild Checksums

## Changed

- Added SHA-256 checksum verification for optional `@ferrite/node` native prebuild packages before their `ferrite-node.node` artifact is loaded.
- Kept explicit `FERRITE_NODE_BINDING` and local source-build artifacts outside checksum verification so development and explicit override paths remain deterministic.
- Updated the native prebuild package generator to write `ferrite-node.sha256.json` and export it from the generated package manifest.
- Expanded `@ferrite/node` resolver tests to cover valid checksum verification, missing checksum manifests, mismatched checksums, malformed checksum manifests, unsupported platforms, and existing override/source-build paths.
- Updated README and architecture docs to describe checksum-verified optional prebuild resolution.

## Why

Optional native packages are only useful if Ferrite can reject incomplete or tampered artifacts before loading native code. Checksums are a small, reviewable step toward a production native distribution pipeline without claiming publishing automation is done.

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

## Generated Package Evidence

On this Mac, `pnpm --filter @ferrite/node prebuild:package` generated an ignored local `@ferrite/node-darwin-arm64` package under `packages/node/dist/prebuild` with:

- `ferrite-node.node`
- `ferrite-node.sha256.json`
- `package.json` exporting both files and listing both in `files`

## Focused Coverage

- Normal path: optional prebuild resolution succeeds when `ferrite-node.node` matches the exported SHA-256 manifest.
- Failure path: optional prebuild resolution rejects missing checksum manifests and mismatched checksums.
- Odd path: malformed checksum manifests with unsupported algorithms fail clearly.
- Compatibility path: explicit `FERRITE_NODE_BINDING` and local source-build artifact resolution are preserved.

## Not Proven

- Published platform packages.
- Multi-platform CI release automation.
- Code-signing or notarization.
- WASM bindings.
- Flight-compatible React Server Components.
