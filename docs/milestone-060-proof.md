# Milestone 060 Proof: Native Prebuild Dry-Run Release

## Changed

- Added supported native prebuild target metadata shared by resolver tests and package verification.
- Added `packages/node/scripts/verify-prebuild-package.mjs` to validate generated native prebuild package directories.
- Added focused verifier tests for valid packages, checksum mismatch, metadata mismatch, and missing aggregate packages.
- Added `.github/workflows/native-prebuild-dry-run.yml` to build, upload, and aggregate-verify native prebuild artifacts on supported hosted runners.
- Updated docs to describe dry-run release automation without claiming npm publication.

## Why

Ferrite can already generate checksum-backed optional native packages locally. This milestone makes the release path production-shaped by adding a repeatable CI dry run that proves package generation and verification across supported runner families before npm publishing exists.

## Proof

- `node --test packages/node/test/prebuild-verifier.test.mjs`
- `pnpm --filter @ferrite/node typecheck`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `pnpm --filter @ferrite/node prebuild:verify`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Focused Coverage

- Normal path: a generated current-platform prebuild package passes verifier checks.
- Failure path: checksum mismatches fail before publication.
- Odd path: package names with mismatched `os` or `cpu` metadata fail clearly.
- Aggregate path: missing expected package artifacts fail the aggregate verifier.

## Not Proven

- Actual GitHub workflow execution, because this local repository has no configured remote.
- npm package publication.
- GitHub release creation.
- Code signing or notarization.
- Availability of every hosted runner in the matrix at execution time.
