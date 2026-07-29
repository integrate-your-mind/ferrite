# Milestone 097: Generated starter path

> **Current status (2026-07-21):** The original registry-shaped `ferrite init` contract below remains unpublished. The repository now exposes the same staged-package path as `pnpm starter:create -- <empty-directory>` and verifies that implementation through real package installation, check, build, pre-build rejection, and artifact serve. See `docs/source-onboarding.md`.

## Outcome

`ferrite init <directory>` creates a minimal TypeScript Ferrite application whose package scripts use build and runtime files from installed packages rather than monorepo paths.

## Behavior

- Creates nested target directories when they do not exist.
- Writes `package.json`, `tsconfig.json`, `app/page.tsx`, and `.gitignore`.
- Pins `@ferrite/runtime` to the CLI's own version.
- Requires an absent target, rejects files, existing directories, and symbolic
  links without modifying them, and publishes a fully staged project with a
  no-replace rename.
- Supports machine-readable global `--json` output through the normal CLI path.

## Integration proof

The npm candidate verifier initializes the starter with the copied candidate CLI, installs locally packed Ferrite tarballs into that generated project, rejects pre-build artifact serving, runs TypeScript-aware `check`, builds through installed runtime scripts, and serves the immutable artifact.

## Explicit gaps

- A public or staging-registry CLI installation is not proven.
- Ferrite npm packages are local candidates, not published packages.
- The source-backed starter vendors host-local artifacts under `.ferrite-source/`; it is not a portable published release.
- Package-manager choice and interactive starter options remain deferred until the minimal path is externally validated.
