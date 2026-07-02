# Milestone 061 Proof: npm Publishing Prep

## Local Proof

- `pnpm install --frozen-lockfile`
- `pnpm test:release`
- `pnpm release:verify:npm`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `pnpm --filter @ferrite/node prebuild:verify`
- `pnpm lint`

The npm package verifier builds `@ferrite/protocol`, `@ferrite/protocol-wasm`, `@ferrite/runtime`, and `@ferrite/node`, runs `npm pack --dry-run --json`, checks required packed files, rejects forbidden local build artifacts, rewrites `workspace:*` dependencies in release-shaped manifests, and writes an ignored local report under `dist/npm-packages/npm-package-report.json`.

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
- npm trusted publishing is not configured.
- No registry token or npm organization access was verified.
- The npm dry-run workflow is committed locally but has not run in GitHub Actions from this checkout.
- `npm publish` was not run.

## Next Milestone

Configure the GitHub remote and real npm publishing workflow with provenance, trusted publishing or `NPM_TOKEN`, and native prebuild artifact publication ordering.
