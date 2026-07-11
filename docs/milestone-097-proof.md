# Milestone 097: Generated starter path

## Outcome

`ferrite init <directory>` creates a minimal TypeScript Ferrite application whose package scripts use build and runtime files from installed packages rather than monorepo paths.

## Behavior

- Creates nested target directories when they do not exist.
- Writes `package.json`, `tsconfig.json`, `app/page.tsx`, and `.gitignore`.
- Pins `@ferrite/runtime` to the CLI's own version.
- Refuses a file target or any non-empty directory without modifying existing files.
- Supports machine-readable global `--json` output through the normal CLI path.

## Integration proof

The npm candidate verifier initializes the starter with the copied candidate CLI, installs locally packed Ferrite tarballs into that generated project, rejects pre-build artifact serving, runs TypeScript-aware `check`, builds through installed runtime scripts, and serves the immutable artifact.

## Explicit gaps

- A public or staging-registry CLI installation is not proven.
- Ferrite npm packages are local candidates, not published packages.
- Package-manager choice and interactive starter options are deferred until the minimal path is externally validated.
