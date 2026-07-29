# CLI distribution candidate

Ferrite can build a release-shaped npm wrapper and one integrity-checked Rust
CLI binary package for the current verified host: macOS on Apple silicon. This
is a local package candidate, not registry publication or broad platform
support.

## Contract

The candidate contains two packages at the same npm prerelease version:

- `@ferrite/cli`, a lifecycle-free JavaScript launcher with the `ferrite` bin;
- `@ferrite/cli-darwin-arm64`, the Rust binary plus a SHA-256 and byte-count
  manifest.

The launcher selects only an explicitly supported platform package, checks its
name, version, `os`, `cpu`, executable mode, size, and SHA-256 before every
execution, then invokes the binary without a shell. It never downloads a
binary, falls back to `PATH`, or runs an install lifecycle script.

The clean-consumer gate also requires the executable's reported Cargo version
to equal the exact SemVer core of the npm package version. For example,
`@ferrite/cli@0.1.0-alpha.0` must execute a binary that reports
`ferrite 0.1.0`.

The npm package version is passed to the Rust process through an
installer-owned environment value. `ferrite init` validates that value as exact
SemVer and pins both `@ferrite/runtime` and `@ferrite/cli` to it. A direct
source-built CLI keeps the existing source-mode skeleton instead.

## Verify locally

From the repository root on macOS arm64:

```sh
pnpm release:verify:cli
```

The gate:

1. builds the real Rust CLI;
2. creates both package candidates in a private sibling;
3. verifies their exact file sets and integrity metadata;
4. atomically replaces only the ignored candidate output, restoring prior
   output if publication fails;
5. packs both directories with npm;
6. installs the two tarballs into an empty directory with lifecycle scripts
   disabled, npm offline mode enabled, and an unreachable registry configured;
7. runs the packaged `ferrite --version`;
8. initializes a project whose path contains spaces;
9. verifies exact runtime and CLI dependency versions;
10. proves non-empty target refusal without changing an owned marker; and
11. tampers with the installed binary and proves execution fails closed.

Generated candidate output lives under `dist/cli-candidate/` and is ignored.
The clean consumer and tarballs used by the gate are temporary and are removed
after the terminal result.

## Current limits

- Only `darwin/arm64` has a defined CLI package target. Intel macOS, Linux,
  Windows, and libc variants are unsupported until their binaries run on real
  matching hosts and pass the same gate.
- A registry `404` for these package names does not prove ownership or the
  right to publish them.
- SHA-256 detects changed bytes after packaging; it does not establish npm
  publisher authenticity, code signing, notarization, or provenance.
- The offline gate proves installation and execution of the two CLI tarballs.
  Installing dependencies for the generated application still requires the
  Ferrite runtime packages and their third-party dependencies from a registry
  or a complete local artifact/cache set.
- The current npm release driver does not include these CLI packages.
  Publication order, ownership, authentication, provenance, registry readback,
  and registry-backed clean installation remain separate release gates.

Rollback for a published prerelease remains npm deprecation and a corrected
version; npm versions are immutable and must never be overwritten. Local
candidate creation preserves the prior verified output until the replacement
has been fully staged and checked.
