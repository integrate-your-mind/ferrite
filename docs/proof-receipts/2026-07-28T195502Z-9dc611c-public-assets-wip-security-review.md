# Public-assets runtime WIP security review

- Reviewed commit: `9dc611ce905ab37bb994642e03fc164e49409e3a`
- Parent: `0480f0fb72fd02260c518edb90988990586fd3b3`
- Branch: `codex/public-assets-runtime-wip`
- Scope: `crates/ferrite-builder/src/legacy.rs`,
  `crates/ferrite-builder/src/legacy/artifact.rs`, and
  `crates/ferrite-dev-server/src/lib.rs`
- Independent review disposition: **REJECT / PRESERVE ONLY**

This commit preserves 526 lines of previously uncommitted public-asset work.
It is not part of PR #13 and must not be merged or presented as a production
feature without resolving the findings below and obtaining executable
exact-head proof.

## Blocking findings

1. **P1: case-insensitive and platform-normalized collisions.** Reserved and
   generated paths are compared byte-for-byte. On a case-insensitive
   filesystem, paths such as `_FERRITE/static/...` can overwrite generated
   client output before the manifest hashes it. Windows device names, alternate
   data streams, and trailing-dot/space aliases are also unhandled.
2. **P1: ancestor-symlink and time-of-check/time-of-use races.** `O_NOFOLLOW`
   protects only the final component. An ancestor can be swapped after
   discovery so build or dev serving reads outside the project tree.
3. **P1: incompatible manifest change under format 1.0.** `publicFiles` is added
   to a deny-unknown-fields schema without changing the declared format
   version, breaking rolling compatibility with the prior 1.0 reader.
4. **P1: unbounded production-memory amplification.** Build and artifact load
   buffer complete files, and each response copies the full asset again.
   Concurrent requests for large public files can exhaust memory.
5. **P2: public/internal path overlap can panic startup.** Manifest validation
   does not reject a public file that is also a server module, prerendered
   output, or client output. Production loading can remove the entry and then
   panic instead of returning an error.
6. **P2: valid filenames are not addressable through HTTP URL encoding.**
   Spaces, Unicode, percent signs, query-sensitive names, and fragment-sensitive
   names can enter the manifest, but the real socket path does not decode them
   into the same lookup key.
7. **P2: immutable caching trusts filename shape.** Hash-looking public names
   receive one-year immutable caching without proving that the apparent digest
   matches the bound artifact digest.

## Required proof before reconsideration

- Normalized, platform-independent collision tests for generated, reserved,
  case-folded, Windows-special, trailing-dot, and trailing-space paths.
- Deterministic ancestor-symlink swap regressions for build and dev serving,
  using handle-relative no-follow traversal for every component.
- Frozen old-reader/build-ID compatibility fixtures and an explicit new
  artifact format contract.
- Bounded-memory large-file startup and concurrent streaming/range tests,
  including disconnect and timeout cleanup.
- Manifest overlap regressions proving artifact load returns `Err` and never
  panics.
- Real-socket encoded filename tests with unsafe encodings failing closed.
- Cache tests that bind immutable URLs to the verified artifact digest.
- Full format, lint, build, unit/integration, coverage, production artifact,
  browser/runtime, failure, odd-path, cleanup, and independent exact-head review
  gates.

## Evidence boundary

The independent review was source-only. `cargo fmt --all -- --check` and
`git diff --check` passed before the preservation commit. No build, unit test,
integration test, coverage run, browser run, or production runtime proof was
executed for this WIP.
