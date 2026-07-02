# Milestone 063 Plan: Staged npm Tarball Manifest Verification

Goal: prove Ferrite's JavaScript-facing npm packages are packed from release-shaped manifests, while keeping source package manifests private and workspace-shaped for local development.

## Scope

- Reproduce the gap where `verifyNpmPackages()` packed directly from `packages/*`.
- Stage each release package into a temporary directory after its build completes.
- Write the rewritten release manifest into the staged package before packing.
- Run real `npm pack --json` against the staged package, not `npm pack --dry-run`.
- Inspect `package/package.json` from the generated `.tgz` and reject `private` or `workspace:*`.
- Keep publishing, registry credentials, and clean-project install smoke tests out of this slice.

## Verification

- Focused verifier tests should fail before the staging implementation and pass after it.
- `pnpm release:verify:npm` should build packages, create temporary tarballs, inspect packed manifests, and write `dist/npm-packages/npm-package-report.json`.
- Docs and audit checklists should distinguish staged tarball manifest proof from clean-install, remote-CI, and npm publication proof.
