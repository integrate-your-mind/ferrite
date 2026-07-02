# Milestone 063 Proof: Staged npm Tarball Manifest Verification

## What Changed

- Changed `scripts/verify-npm-packages.mjs` to copy each release package into a temporary staging directory after building.
- Wrote the release-shaped manifest into the staged package before packing, leaving source `packages/*/package.json` files untouched.
- Replaced default `npm pack --dry-run --json` proof with real `npm pack --json` into temporary tarballs.
- Added tarball manifest inspection for `package/package.json`.
- Added validation that packed manifests omit `private`, omit `workspace:*`, match release package names and versions, and preserve rewritten release dependency fields.
- Updated the npm package report to include both `releaseManifest` and `packedManifest`.
- Follow-up milestone 064 extended this verifier to clean-install the generated tarballs together in an offline temp project.

## Normal Path Proof

- `node --test scripts/verify-npm-packages.test.mjs`: passed 9 tests after the staging implementation.
- `pnpm test:release`: passed 9 verifier tests.
- `pnpm lint`: passed Cargo fmt/clippy and package type checks.
- `pnpm typecheck`: passed package type checks plus `ferrite check --project examples/basic`.
- `pnpm test`: sandboxed run failed only on local socket permission errors; escalated rerun passed the full Rust, script, protocol, WASM, runtime, and native package test suites.
- `pnpm build`: passed the full Rust workspace and JS package build.
- `pnpm release:verify:npm`: passed outside the sandbox after the sandboxed run hit npm log-directory permissions. It built `@ferrite/protocol`, `@ferrite/protocol-wasm`, `@ferrite/runtime`, and `@ferrite/node`, created staged tarballs, inspected packed manifests, and wrote `dist/npm-packages/npm-package-report.json`.
- `rg -n 'workspace:\*|"private"' dist/npm-packages/npm-package-report.json`: no matches.
- `git diff --check`: passed.

## Failure Path Proof

- `node --test scripts/verify-npm-packages.test.mjs`: first failed before the implementation because the verifier still packed from the source package directory.
- Added `validatePackedManifest()` coverage that rejects packed manifests containing `private: true`.
- Added `validatePackedManifest()` coverage that rejects packed manifests containing Ferrite `workspace:*` dependency specifiers.

## Odd Path Proof

- The staging test proves the source runtime manifest remains private and keeps `@ferrite/protocol: "workspace:*"` after verification, while the staged packed manifest rewrites that dependency to `0.1.0`.
- The real verifier still validates forbidden packed files, so source-only files can exist in the staging directory as long as package `files` excludes them from the tarball.

## Not Proven

- At the time of milestone 063, clean-project installation from the generated local tarballs was not proven; milestone 064 now proves local clean offline install smoke.
- npm publication, trusted publishing, provenance, or registry credentials.
- Remote CI, because this checkout has no configured Git remote.
