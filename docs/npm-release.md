# npm release

Ferrite's first npm release is a developer-preview prerelease. Publication is
allowed only from a reviewed, exact-head candidate after the repository's
Buildkite, package, registry, and approval gates pass.

## First release boundary

The portable package set is published in dependency order:

1. `@ferrite/protocol`
2. `@ferrite/protocol-wasm`
3. `@ferrite/runtime`

Use prerelease versions such as `0.1.0-alpha.0` and the `next` dist-tag. Do not
assign `latest` until a later compatibility and support review.

`@ferrite/node` and its native packages are a separate atomic set. Publish all
five declared native target packages before publishing `@ferrite/node`:

- `@ferrite/node-darwin-arm64`
- `@ferrite/node-darwin-x64`
- `@ferrite/node-linux-arm64-gnu`
- `@ferrite/node-linux-x64-gnu`
- `@ferrite/node-win32-x64-msvc`

The current-host package verifier proves only the macOS arm64 native artifact.
Publishing the parent package before the complete target set would make its
declared optional dependency and runtime support contract false on other
platforms.

This release does not distribute the Rust `ferrite` CLI. The supported
developer-preview workflow remains a source checkout and the
`pnpm starter:create` path documented in [Source onboarding](source-onboarding.md).

## Required gates

Bind every receipt to the exact candidate commit and tree.

- The pull request is not a draft, has the required distinct approval, and has
  no unresolved review thread.
- The exact candidate passes the dedicated Buildkite `verify`, `packages`,
  `coverage-rust`, `coverage-js`, and applicable native/runtime gates.
- `pnpm release:verify:npm` preserves the verified tarballs under
  `dist/npm-packages/tarballs/`. Every preserved file must match the filename,
  byte size, and SHA-256 value in `npm-package-report.json`. The report envelope
  must bind the exact Git commit/tree, Buildkite build/job, and complete package
  set digest.
  Verification captures the exact Git commit/tree before any package build or
  install and checks it again before replacing prior report/tarball outputs and
  after persistence; source drift restores the prior generated outputs. A
  recursively discovered `npm-publication-receipt.json` is never removed or
  overwritten; artifact regeneration stops until that receipt is reconciled.
  Prior outputs are renamed into a same-directory `.previous-report-*` backup
  so replacement stays on one filesystem. Any backup left by an interrupted
  verifier blocks regeneration until an operator preserves and reconciles it.
- `pnpm release:plan:npm` succeeds and emits the portable dependency order
  from those exact retained bytes. The planner reopens each gzip/tar archive and
  compares its real file list and `package/package.json` with the report. It also
  uses Buildkite API access with `read_builds` and `read_artifacts` scopes to
  verify the exact passed build, package job, report artifact, tarball paths,
  byte sizes, and SHA-1 upload identities before applying the report's SHA-256
  and archive checks. The command validates but never authenticates to npm or
  publishes.
- A clean directory installs those exact tarballs and passes the package smoke
  and starter workflow before any registry mutation.
- The authenticated npm identity passes a fail-closed preflight against exactly
  `https://registry.npmjs.org/`: `npm whoami --json`, `npm profile get --json`
  must report the `two-factor auth` mode `auth-and-writes`, and
  `npm org ls ferrite <identity> --json` must report the `owner`, `admin`, or
  `developer` role. Existing packages must be `read-write` in
  `npm access list packages <identity> --json`; every exact intended version
  must be absent, with only an authenticated exact-version `E404` accepted.
  These checks are captured in the receipt and repeated immediately before
  each publish. Registry arguments are pinned explicitly on every npm command.
- The version, package list, dependency order, dist-tag, release notes, and
  rollback owner are recorded before publication.
- No token, OTP, recovery code, or `.npmrc` content is written to the
  repository or printed into CI logs.

An npm registry `404` before authentication is not ownership proof. Repeat
collision and access checks after authenticating.

## Provenance boundary

npm provenance requires a supported cloud-hosted CI provider. npm's current
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/)
documentation does not support self-hosted Buildkite agents. Therefore a local
Buildkite publish must not claim npm provenance.

Ferrite does not use GitHub Actions. If provenance remains a release
requirement, publication stays blocked until npm supports the approved
Buildkite topology or the maintainer explicitly approves a different supported
publication path. A manual token or OTP publish does not close this provenance
gap.

## Publication sequence

1. Freeze the exact reviewed commit and rerun the complete Buildkite proof.
2. Generate and retain the exact package tarballs.
3. Verify report identities against the retained files.
4. Authenticate to npm interactively without recording credentials.
5. Confirm package ownership and that no intended version already exists.
6. Run the guarded publication driver with the explicit execution flag:

   ```sh
   node scripts/publish-npm-release.mjs \
     --report dist/npm-packages/npm-package-report.json \
     --receipt dist/npm-packages/npm-publication-receipt.json \
     --version 0.1.0-alpha.0 \
     --tag next \
     --execute
   ```

   The driver revalidates source, Buildkite identity, report, archive contents,
   and digest before every package, copies the verified bytes into a private
   read-only staging directory, then publishes in dependency order with
   `--access public --tag next`. It stops at the first failure and removes its
   staging directory. It atomically writes the exact source, build, package set,
   and authenticated registry identity/access/version evidence,
   successful packages, and any partial failure to the publication receipt
   immediately before and after each registry mutation. Confirmed successes,
   deterministic pre-publish failures, ambiguous registry outcomes, and local
   cleanup/receipt failures are disjoint receipt fields. An interrupted receipt
   retains the package whose registry state must be read back before retry.
   The driver assigns every attempt a unique ID, creates the first receipt
   exclusively, refuses to overwrite an earlier attempt, and syncs receipt files
   plus their parent directory around atomic replacement. Reconcile or archive
   an existing receipt before choosing a new receipt path. Never repack between
   proof and publication.
7. Read each version and dist-tag back from the registry.
8. Install the exact registry versions in a clean directory and rerun the
   portable package smoke.
9. Create the Git tag and GitHub release only when their commit and release
   notes match the published package set.
10. Record package URLs, versions, dist-tags, registry integrity/provenance
    fields, local SHA-256 values, and the clean-consumer result.

## Failure and rollback

- Stop on the first publish failure. Do not continue to a dependent package.
- Never overwrite or reuse a published version.
- If a package is broken, publish a fixed prerelease version and move `next` to
  it only after verification.
- Deprecate the broken exact version with a concise replacement message.
- If a prior good prerelease exists, move `next` back to that version.
- Prefer deprecation over unpublish. Treat unpublish as a separate destructive
  registry action subject to npm policy and explicit maintainer approval.
- Preserve `npm-publication-receipt.json` after every attempt. A `partial`
  receipt names confirmed published packages separately from any ambiguous
  in-flight package or post-publication local failure. Read ambiguous and
  confirmed versions back from the registry before deciding whether to retry.
