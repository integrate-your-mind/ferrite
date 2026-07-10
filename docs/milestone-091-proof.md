# Milestone 091 Proof

## Scope

Make the Rust workspace technically packageable and define one remote full-gate workflow without inventing repository, license, registry, or CI evidence.

## Reproduced Failure

`cargo package --workspace --allow-dirty --no-verify` initially packaged `ferrite-protocol`, then stopped because `ferrite-client-bundler` depended on `ferrite-protocol` by path without a version requirement.

## Implemented

- Every internal Cargo path dependency now also requires Ferrite version `0.1.0`.
- Workspace crates declare the Rust 1.85 minimum required for edition 2024.
- Every crate has a package description.
- The fake `https://example.invalid/ferrite` repository metadata was removed.
- `pnpm release:verify:cargo` packages the complete workspace.
- The npm verification workflow also executes the Cargo archive gate.
- `.github/workflows/verify.yml` defines lint, typecheck, build, full tests, installed Chromium, real example integration, npm tarball verification, Cargo archive verification, and report upload.

## Local Proof

- `pnpm release:verify:cargo` packaged all 11 workspace crates.
- Ruby's YAML parser loaded all three workflow files.
- The Playwright Core CLI and Chromium executable resolver used by the workflow were verified locally.

## Explicitly Not Proven

- The new workflow has not run remotely because this checkout has no Git remote.
- Cargo crates have not been published or installed from a registry.
- Package publication order has not been exercised.
- Real repository/homepage/documentation metadata awaits the repository decision.
- npm packages remain source-private and `UNLICENSED`; licensing must be resolved before public release.
