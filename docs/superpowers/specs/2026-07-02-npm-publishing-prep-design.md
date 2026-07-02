# npm Publishing Prep Design

Status note, July 2, 2026: this design captured the original milestone 061 dry-run verifier. Milestone 063 superseded the npm verifier behavior by staging release-shaped package copies, running real `npm pack --json`, inspecting packed `package/package.json`, and recording both release and packed manifests. Milestone 064 added clean offline install smoke for the generated tarballs. Remote CI and npm publication remain unproven.

## Purpose

Milestone 061 prepares Ferrite's JavaScript-facing packages for real npm publication without publishing anything. Milestone 060 proved a dry-run native prebuild packaging path, but all workspace packages remain private and there is no remote, npm registry configuration, trusted publisher, or token setup in this checkout. This milestone should make the publishable package metadata explicit, prove package tarball contents locally, and draft release automation that can be enabled once GitHub/npm publishing state exists.

This is publish readiness, not release execution.

## Scope

In scope:

- Define which packages are intended to become public npm packages.
- Add package metadata required for npm readiness: description, license, repository, publish access, keywords, and stable packed file lists.
- Add a release verifier that can build each public package, stage release manifests, inspect packed contents, and fail on missing release files.
- Add a non-publishing release dry-run workflow for package publication checks.
- Document local proof, remote proof gaps, and the next publishing milestone.

Out of scope:

- Removing `private: true` from packages until the verifier proves publish readiness.
- Running `npm publish`.
- Adding registry tokens, trusted publisher state, or secrets.
- Creating GitHub releases or tags.
- Publishing native prebuild packages.
- Signing, notarization, or SLSA policy beyond documenting provenance requirements.
- Changing runtime APIs.

## Publishable Package Set

The intended public package set is:

- `@ferrite/protocol`
- `@ferrite/protocol-wasm`
- `@ferrite/runtime`
- `@ferrite/node`
- generated native packages from `SUPPORTED_NATIVE_PREBUILD_TARGETS`

The root `ferrite-workspace` package and `examples/basic` remain private.

Generated native packages are not checked in. Their manifests are produced by `packages/node/scripts/create-prebuild-package.mjs`, then verified by `packages/node/scripts/verify-prebuild-package.mjs`.

## Package Metadata Design

Each publishable source package should have:

- `description`
- `license`
- `repository`
- `homepage`
- `bugs`
- `keywords`
- `publishConfig.access: "public"`
- precise `files`
- exports with type entries where applicable

`@ferrite/protocol`, `@ferrite/protocol-wasm`, and `@ferrite/runtime` can carry normal workspace dependencies during development. The current local verifier stages release-shaped package copies, runs real `npm pack --json`, inspects the packed `package/package.json`, installs the generated tarballs together in a clean offline temp project, and records both release and packed manifests in `dist/npm-packages/npm-package-report.json`. Packed manifests must not contain `private: true` or `workspace:*`.

`@ferrite/node` needs special handling for platform packages. Adding optional dependencies for unpublished native packages directly to the source manifest can cause local installs to resolve packages that do not exist yet. The safer first slice is:

- Keep source development deterministic.
- Add release metadata that describes expected optional native packages.
- Add verifier checks that fail if a publish manifest lacks the expected optional native package entries.
- Decide in the implementation plan whether to generate a temporary publish manifest for `npm pack` checks or to add source `optionalDependencies` only after proving local `pnpm install --frozen-lockfile` remains stable.

## Release Verifier Design

Add a dependency-free Node script, tentatively `scripts/verify-npm-packages.mjs`.

Responsibilities:

- Build required packages before inspection.
- Run `npm pack --json` in each staged public package directory.
- Parse the returned file list.
- Verify required release contents for each package.
- Verify package metadata fields.
- Verify release-shaped manifests do not contain `private: true` when running in publish-manifest mode.
- Verify release-shaped manifests do not contain `workspace:*` dependency specifiers, and add a later tarball-staging check that proves the same invariant in actual packed package manifests.
- Verify package names and versions are aligned across Ferrite packages.
- Verify `@ferrite/protocol-wasm` includes `dist/ferrite_protocol_wasm.wasm`.
- Verify `@ferrite/node` includes `binding.js`, `index.js`, `index.d.ts`, and excludes local source-build `dist/ferrite-node.node` from the main package unless the design intentionally keeps source-build fallback artifacts in the package.
- Verify generated native prebuild package manifests include `publishConfig.access: "public"` or an equivalent public publish path before actual publication is enabled.

The verifier should not require npm authentication and should not contact the registry. Use staged `npm pack --json` rather than `npm publish --dry-run` for local deterministic proof. `npm publish --dry-run` can remain documented as a later remote/manual proof because npm may perform registry or auth checks even in dry-run mode.

## Workflow Design

Add a non-publishing workflow draft, tentatively `.github/workflows/npm-publish-dry-run.yml`.

Triggers:

- `workflow_dispatch`
- `pull_request` and `push` limited to package/release files

Permissions:

- `contents: read`

Jobs:

- Checkout.
- Set up pnpm and Node.
- Install with `pnpm install --frozen-lockfile`.
- Run the package verifier.
- Upload pack inspection reports as artifacts.

Do not grant `id-token: write` in this dry-run workflow. The real publish workflow should use `id-token: write`, GitHub-hosted runners, npm provenance, and either trusted publishing or a clearly named `NPM_TOKEN` secret. Keeping the dry-run workflow read-only makes it safe to run before registry setup.

## Real Publish Workflow Requirements

The next milestone should add a real publish workflow only after:

- The repository has a GitHub remote.
- npm organization/package names are confirmed.
- npm trusted publishing or token-based publishing is configured.
- Release trigger policy is chosen, such as tag-based or GitHub release-based.
- The native prebuild dry-run has passed on every supported runner.
- Package tarball verification passes locally and in CI, including manifest inspection after rewritten publish manifests are staged.

When real publishing is enabled, scoped packages should publish with public access and provenance. For first-time scoped package publication, the command shape should be equivalent to:

```sh
npm publish --provenance --access public
```

## Error Handling

The verifier should fail closed for:

- Missing package metadata.
- Missing required files in packed output.
- Unexpected packed source files, local build leftovers, or test fixtures.
- `workspace:*` dependency specifiers in packed manifests.
- Version mismatches between Ferrite packages.
- Missing WASM artifact in `@ferrite/protocol-wasm`.
- Missing expected native package metadata.
- Rewritten release manifests existing only in report output instead of the actual packed tarball.
- Any attempted publish command in the dry-run workflow.

Error messages should identify the package, field, and expected invariant.

## Testing And Proof

Local proof for the design implementation:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @ferrite/protocol build`
- `pnpm --filter @ferrite/protocol-wasm build`
- `pnpm --filter @ferrite/runtime build`
- `pnpm --filter @ferrite/node build`
- `node scripts/verify-npm-packages.mjs`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

Remote proof after a GitHub remote exists:

- Successful `npm-publish-dry-run.yml`.
- Artifact containing pack inspection reports.
- Existing native prebuild dry-run passing for every supported runner.
- A clean-project install from staged tarballs whose package manifests no longer contain source-only `private` or `workspace:*` fields. This is now locally proven; remote CI still needs to run it.

## Documentation Updates

Add `docs/milestone-061-plan.md` and `docs/milestone-061-proof.md`.

Update `README.md` and `docs/architecture.md` to distinguish:

- npm publication is prepared but not performed.
- remote CI proof is unavailable in this local checkout until a remote exists.
- the current verifier proves release-shaped manifests in report output, not actual rewritten tarball manifests.
- real publish automation remains the next release milestone.

## Acceptance Criteria

- The intended publishable package set is explicit.
- Package metadata is ready for dry-run publication checks.
- Local package verifier proves packed file lists and report-level release-manifest invariants, with actual rewritten tarball manifests left as an explicit follow-up.
- The dry-run workflow has no publish side effects and no registry credentials.
- Full local gates pass.
- The proof document lists npm publishing, trusted publishing setup, registry credentials, and real remote CI execution as not proven when they are not available.

## Next Milestone

After publish-prep dry runs pass, the next release milestone should add the real npm publish workflow gated on tags or GitHub releases, provenance, trusted publishing or `NPM_TOKEN`, and native prebuild artifact publication ordering.
