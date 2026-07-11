# Milestone 096: Clean candidate install proof

## Outcome

Ferrite's npm release verifier now proves a developer workflow outside the monorepo using locally packed candidate packages and a freshly built copied CLI binary.

## Production fixes

- `@ferrite/runtime` declares exact-pinned `esbuild` and `typescript` production dependencies because its shipped renderer and bundler require them.
- The verifier permits optional dependencies so esbuild installs its platform binary.
- `release:verify:npm` builds `ferrite-cli` before copying it into the clean project.
- The clean fixture has no workspace source aliases or workspace dependencies.

## Paths proved

- Failure: artifact serve rejects the missing artifact before build.
- Normal: TypeScript-aware `ferrite check` succeeds using the installed TypeScript compiler.
- Normal: `ferrite build` succeeds using renderer and bundler scripts from the installed runtime tarball.
- Normal: artifact-backed `ferrite serve --once` renders fixture HTML.
- Odd: the workflow fails if the served response does not contain the fixture output.

## Explicit gaps

- Ferrite packages and the CLI were not installed from a public or staging registry.
- Optional `@ferrite/node` native prebuild loading from a registry is not proven.
- External exact-pinned dependencies resolve over the network during the clean install.
- No Git remote, PR, hosted CI, publication, or deployment is proven by this milestone.
