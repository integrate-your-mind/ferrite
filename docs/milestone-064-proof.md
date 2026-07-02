# Milestone 064 Proof: Clean npm Tarball Install Smoke

## What Changed

- Extended `scripts/verify-npm-packages.mjs` so every packed package keeps an internal local tarball path until verification finishes.
- Added `installPackedPackageSet()` to create a fresh temp project, run `npm install` over the generated local tarballs, and clean the fixture afterward.
- Runs install smoke with `--offline`, `--ignore-scripts`, `--omit=optional`, `--package-lock=false`, `--no-audit`, and `--fund=false`.
- Smoke-imports `@ferrite/protocol`, `@ferrite/protocol-wasm`, and `@ferrite/runtime` from the clean install.
- Verifies `@ferrite/node` is installed from the local tarball without importing it, because optional native prebuild packages are still publication-dependent.

## Normal Path Proof

- `node --test scripts/verify-npm-packages.test.mjs`: passed 10 verifier tests.
- `pnpm test:release`: passed 10 verifier tests.
- `pnpm lint`: passed Cargo fmt/clippy and package type checks.
- `pnpm typecheck`: passed package type checks plus `ferrite check --project examples/basic`.
- `pnpm build`: passed the full Rust workspace and JS package build.
- `pnpm release:verify:npm`: passed outside the sandbox after the sandboxed run hit npm log-directory permissions. It built all JS-facing packages, packed staged manifests, inspected packed manifests, installed all generated tarballs together in a clean temp project, ran the safe import/package-presence smoke, and wrote `dist/npm-packages/npm-package-report.json`.
- `pnpm test`: passed outside the sandbox so local TCP socket integration tests can bind/listen.
- `rg -n 'workspace:\*|"private"' dist/npm-packages/npm-package-report.json`: no matches.
- `git diff --check`: passed.

## Failure Path Proof

- The new clean-install test first failed before implementation because `verifyNpmPackages()` never invoked the install-smoke hook.
- Existing packed-manifest failure coverage still rejects `private: true` and Ferrite `workspace:*` dependency specifiers before install.
- The install smoke fails closed if any package entry lacks a local tarball path.

## Odd Path Proof

- `@ferrite/node` is included in the clean install but is not imported, so the smoke proves package-manager consumption without pretending optional native prebuild packages are already published.
- Optional native dependencies are omitted intentionally during the local install smoke to avoid registry resolution for unpublished native packages.

## Not Proven

- npm publication, trusted publishing, provenance, or registry credentials.
- Remote CI, because this checkout has no configured Git remote.
- Hosted-runner native optional prebuild installation from published packages.
