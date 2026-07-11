# Milestone 094 Proof

## Scope

Restore the native prebuild workflow's Darwin x64 job to a currently supported GitHub-hosted runner without changing the package target or claiming hosted proof.

## Change

- Replaced the retired `macos-13` runner with `macos-15-intel` for `@ferrite/node-darwin-x64`.
- Kept the Darwin arm64, Linux arm64/x64, and Windows x64 matrix entries unchanged.
- Preserved the aggregate artifact verification job and read-only workflow permissions.

GitHub's [macOS 13 retirement notice](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/) states that `macos-13` was retired on December 4, 2025 and identifies `macos-15-intel` as a standard x64 migration target.

## Local Proof

- `actionlint` accepts all three workflow files with the updated hosted-runner matrix.
- A dependency-free repository test rejects `macos-13` and pins the Darwin arm64/x64 packages to their architecture-specific runner labels.
- The existing local native package tests and `pnpm release:verify:npm` gate remain green.

## Explicitly Not Proven

- The native prebuild matrix has not run on GitHub-hosted runners from this checkout.
- No native package was published, signed, notarized, or installed from a registry.
- This checkout still has no Git remote, so no push, PR, or exact-commit remote CI exists.

Historical milestone 060 design and plan documents retain the runner labels used at the time; this milestone supersedes that operational matrix rather than rewriting historical evidence.
