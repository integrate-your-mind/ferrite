# Native Prebuild Dry-Run Release Design

## Purpose

Milestone 060 adds a non-publishing release proof for Ferrite native Node prebuilds. The project already has a local `@ferrite/node` native addon build, optional platform package resolution, generated checksum manifests, and checksum verification. The remaining release gap is proving that supported platform packages can be built and validated on the matching runner families without relying on this Mac.

This milestone should produce reviewable CI artifacts and local verification commands. It must not publish packages, require npm credentials, or claim production release automation is complete.

## Scope

In scope:

- Add the first GitHub Actions workflow for native prebuild dry-run packaging.
- Build and package `@ferrite/node` on supported hosted runner/platform pairs.
- Upload each generated optional native package as a workflow artifact.
- Add a repository-owned verification script for generated prebuild package directories.
- Verify package metadata, expected files, and SHA-256 manifest integrity.
- Document the proof, limits, and next milestone.

Out of scope:

- Publishing to npm.
- GitHub release creation.
- Code signing or notarization.
- Cross-compiling native packages on a runner that does not match the target package.
- Changing the native addon API.
- Changing runtime package resolution semantics.

## Workflow Design

Add `.github/workflows/native-prebuild-dry-run.yml`.

Triggers:

- `workflow_dispatch` for manual validation.
- `push` and `pull_request` paths limited to release-relevant files once the repository has a remote.

Permissions:

- `contents: read`.

Build job:

- Use a matrix of target packages and runners.
- Install Rust stable, Node, and pnpm.
- Run `pnpm install --frozen-lockfile`.
- Run `pnpm --filter @ferrite/node prebuild:package`.
- Run the prebuild verifier against `packages/node/dist/prebuild`.
- Upload the generated package directory as an artifact named after the package target.

Verification job:

- Download all uploaded artifacts.
- Run the verifier over the downloaded package directories.
- Fail if any expected package artifact is missing.

## Initial Matrix

The matrix should match the package names already encoded in `packages/node/binding.js`:

| Package | Runner | Platform expectation |
| --- | --- | --- |
| `@ferrite/node-darwin-arm64` | `macos-latest` | `os: ["darwin"]`, `cpu: ["arm64"]` |
| `@ferrite/node-darwin-x64` | `macos-13` | `os: ["darwin"]`, `cpu: ["x64"]` |
| `@ferrite/node-linux-x64-gnu` | `ubuntu-latest` | `os: ["linux"]`, `cpu: ["x64"]` |
| `@ferrite/node-linux-arm64-gnu` | `ubuntu-24.04-arm` | `os: ["linux"]`, `cpu: ["arm64"]` |
| `@ferrite/node-win32-x64-msvc` | `windows-latest` | `os: ["win32"]`, `cpu: ["x64"]` |

If a listed hosted runner is unavailable when CI is enabled, the implementation should fail clearly and document the unavailable target rather than silently removing coverage.

## Verifier Design

Add `packages/node/scripts/verify-prebuild-package.mjs`.

Inputs:

- One or more package directory paths.
- Optional `--expect <package-name>` values for CI aggregate verification.

Checks for each package directory:

- `package.json` exists and parses as a JSON object.
- `ferrite-node.node` exists and is non-empty.
- `ferrite-node.sha256.json` exists and parses as a JSON object.
- `package.json.name` is one of the supported native prebuild package names.
- `package.json.version` matches `packages/node/package.json`.
- `package.json.files` includes `ferrite-node.node` and `ferrite-node.sha256.json`.
- `package.json.exports` exposes `./ferrite-node.node` and `./ferrite-node.sha256.json`.
- `package.json.os` and `package.json.cpu` match the package name mapping.
- `ferrite-node.sha256.json.file` is `ferrite-node.node`.
- `ferrite-node.sha256.json.algorithm` is `sha256`.
- `ferrite-node.sha256.json.sha256` is a lowercase 64-character hex digest.
- The digest matches the actual native binding bytes.
- All expected package names passed with `--expect` are present exactly once.

The verifier should be deterministic, dependency-free, and runnable on macOS, Linux, and Windows.

## Error Handling

The build workflow should fail closed:

- Missing native build output fails before package upload.
- Missing checksum manifest fails verification.
- Mismatched checksum fails verification.
- Unknown package names fail verification.
- Duplicate or missing expected artifacts fail aggregate verification.

Error messages should name the package directory and the failed invariant.

## Testing And Proof

Local proof before commit:

- `pnpm --filter @ferrite/node typecheck`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `node packages/node/scripts/verify-prebuild-package.mjs packages/node/dist/prebuild`
- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `pnpm typecheck`

CI proof after a remote exists:

- A successful `native-prebuild-dry-run.yml` run.
- Artifacts for every supported package in the matrix.
- Aggregate verification job output showing every expected package was present and checksum-valid.

## Documentation Updates

Add `docs/milestone-060-plan.md` and `docs/milestone-060-proof.md`.

Update `README.md` and `docs/architecture.md` to say Ferrite has a dry-run native prebuild release workflow, while still not claiming npm publishing, signing, notarization, or real GitHub CI proof until a remote run exists.

## Acceptance Criteria

- The workflow file is present and uses the supported package matrix.
- The verifier script is covered by focused tests or direct proof fixtures.
- Local prebuild generation still works for the current platform.
- The generated current-platform package passes the verifier.
- Full local test, lint, build, and typecheck gates pass.
- The proof document states that no GitHub workflow run was proven locally if the repository still has no remote.

## Next Milestone

After this dry-run workflow exists, the next release milestone should add real publish preparation: package privacy/publication metadata, provenance or signing decisions, and an npm publish workflow gated on tags and required secrets.
