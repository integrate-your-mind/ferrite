# Milestone 064 Plan: Clean npm Tarball Install Smoke

Goal: prove Ferrite's generated JS-facing npm tarballs can be consumed together by a clean project without publishing packages or resolving unpublished Ferrite packages from the registry.

## Scope

- Add a failing verifier test showing the tarball set is handed to an install-smoke step.
- Preserve local tarball paths internally while keeping temp paths out of `dist/npm-packages/npm-package-report.json`.
- Install all generated package tarballs together in a fresh temp project.
- Run npm in offline mode with optional dependencies omitted so the smoke cannot fetch unpublished Ferrite packages.
- Smoke-import `@ferrite/protocol`, `@ferrite/protocol-wasm`, and `@ferrite/runtime`.
- Check `@ferrite/node` is installed from the local tarball without importing it, because native optional prebuild packages are still not published.

## Out Of Scope

- Publishing to npm.
- Installing optional native prebuild packages from the registry.
- Remote CI proof.
- Provenance, trusted publishing, tags, or GitHub releases.

## Verification

- `node --test scripts/verify-npm-packages.test.mjs` should fail before implementation because the install-smoke hook is never called.
- `pnpm release:verify:npm` should build, pack, inspect, clean-install, and smoke-check all local tarballs.
