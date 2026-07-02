# Milestone 061 Proof: npm Publishing Prep

## Local Proof

- `pnpm install --frozen-lockfile`
- `pnpm test:release`
- `pnpm release:verify:npm`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `pnpm --filter @ferrite/node prebuild:verify`
- `pnpm lint`

The npm package verifier builds `@ferrite/protocol`, `@ferrite/protocol-wasm`, `@ferrite/runtime`, and `@ferrite/node`, runs `npm pack --dry-run --json`, checks required packed files, rejects forbidden local build artifacts, validates release-shaped manifests in memory, and writes an ignored local report under `dist/npm-packages/npm-package-report.json`.

Follow-up audit on July 2, 2026 found an important limitation: the verifier does not yet pack staged release manifests. Live tarball inspection showed the actual packed `package.json` files still come from the source packages, so they still include `private: true`; `@ferrite/runtime` and `@ferrite/protocol-wasm` also still include `workspace:*` dependencies in their packed manifests. This milestone proves local dry-run file lists and in-memory release-manifest rewriting, not installable release tarball manifests.

The native prebuild verifier now requires generated native package manifests to include description, `UNLICENSED`, Ferrite keywords, and `publishConfig.access: "public"`.

## Remote Proof Not Available

- This checkout has no configured Git remote.
- The npm dry-run workflow is committed locally but has not run in GitHub Actions from this checkout.
- Native prebuild matrix proof remains local-file proof plus the committed workflow definition until a remote runs the workflow.

## Real Publish Not Performed

- `npm publish` was not run.
- No npm package, native prebuild package, GitHub release, or tag was created.
- No registry credential, trusted publisher, or provenance-producing publish workflow was configured.

## Known Gaps

- This checkout has no configured Git remote, so repository, homepage, and issue URLs for real npm package manifests are not proven.
- Actual release tarball manifests are not yet proven publishable; the current tarballs still contain source-manifest `private: true`, and some still contain `workspace:*` dependency specifiers.
- Clean-project package installation from generated tarballs has not been proven.
- npm trusted publishing is not configured.
- No registry token or npm organization access was verified.
- The npm dry-run workflow is committed locally but has not run in GitHub Actions from this checkout.
- `npm publish` was not run.

## Next Milestone

Configure the GitHub remote and real npm publishing workflow with provenance, trusted publishing or `NPM_TOKEN`, and native prebuild artifact publication ordering.
