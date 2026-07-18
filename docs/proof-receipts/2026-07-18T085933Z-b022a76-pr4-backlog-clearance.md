# PR #4 Exact-Source Backlog Clearance Receipt

Recorded: 2026-07-18T08:59:33Z

## Identity

- Delivery unit: draft PR #4, `codex/module-graph-hardening`
- Tested source commit: `b022a76956c4d3ca45c65a957e5be5cbb508d659`
- Tested source tree: `9ee1747ea91a3f57e54a90338a6669f8e94222cd`
- Base: `main` at `d10b4e9c364f533d621a9cd151bbcd1bb161278c`
- Remote branch and pull head before the final push: `55302c0810f0e1fc2e15d3867451876ccd6203c3`
- Remote merge ref before the final push: `ea92d87688c38476e34314e943f6df2e54a28511`
- Sole mutable owner: root task in `codex/module-graph-backlog-fix`
- Independent advisory reviewer: `/root/pr4_final_security_review`; read-only and no merge authority
- Environment: macOS 26.5.2 build 25F84, arm64, Node 24.13.0, pnpm 11.7.0, Homebrew Rust 1.95.0, declared MSRV Rust 1.85.0, cargo-llvm-cov 0.8.5, Actionlint 1.7.12
- Artifact manifest: 12,228 bytes, SHA-256 `922bdf826c5d15288e3ff853e59d28e4d8e08f1eb9831d28bf94606d0088355f`
- Artifact build id: `sha256:e2e8fd9f2f68e29b55c05c759250ab0bb8c08d5afc5704e819438882f9b81411`
- Canonical 25-file artifact hash-list SHA-256: `268daaa5ee941fc6cab568ad63421112a5a8a040e671b30d602456fed39b889c`
- `Cargo.lock` SHA-256: `cf5a096c562abdaae60f34b2541e105edd48bc4b546df9090f2892b0e951e0a2`

The documentation commit containing this receipt follows the tested source
commit. It changes no runtime source, tests, manifests, dependencies, or build
configuration, so all executable proof below is tied to `b022a76`.

## Reproduced Findings And Disposition

| Finding | Reproduction | Fix and regression |
| --- | --- | --- |
| Nondeterministic production artifacts | Two consecutive same-source builds produced build ids `sha256:71cfdc8130926c4463e9195b190a02f502bfd4077ead63e8bd6534ccaa97927f` and `sha256:87d4098c70de73097588f9111fcd5376a4632db5a1fded39a019eee26b7bfb0e`. Random generated-entry paths leaked through JavaScript comments and source maps. | Generated route, client-reference, and action-bootstrap entries now use stable esbuild stdin identities and project-relative imports. A real three-case regression compares metadata and every output byte. Two complete artifact builds now match exactly. |
| Failed retry leaked attempt outputs | The resolver-race test could leave the first attempt's bundle in the output directory even when its graph snapshot was rejected. | Every attempt builds in sibling staging. Only a validated snapshot is published. The race regression requires version-B-only output and empty staging; 20 separate process runs passed. |
| Invalid published source maps | Moving maps from project-root staging made their relative sources resolve beneath `.ferrite` or `examples`, where the sources did not exist. All three production maps reproduced the failure. | Sibling staging preserves final path depth. Tests resolve every real source from each published map and require embedded virtual generated sources. Physical proof resolved 12 real sources, embedded two generated sources, matched all 12 `sourcesContent` values, and found zero staging paths. |
| Output symlink escape | A pre-existing `out/assets` symlink caused the production bundler to write `mark-DYGCCYGL.svg` outside `outDir`. | Publication rejects aliased parents and non-regular staged or destination files, uses an exclusive private publish directory, and renames validated files. Directory- and file-symlink regressions preserve the outside directory and sentinel. |
| Cleanup fixture race | A full exact-head run observed an empty PID file after existence became visible before `writeFile` completed. | The fixture writes a staging PID file and atomically renames it. The focused negative cleanup test passed 50 separate process runs before the full suite. |

Earlier graph/cycle/config resolution, convention-root snapshot, invalidation,
slow-client, action-error, deployment, signal-drain, MSRV, and cross-target
reproductions remain in the preceding PR #4 receipts. This receipt supersedes
their readiness claims with the final source and reviewer result.

## Exact-Source Gates

| Gate | Command | Result |
| --- | --- | --- |
| Primary chain | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` | Exit 0. Rustfmt, Clippy with warnings denied, TypeScript/Node checks, workspace/package builds, 269 Rust tests, and 215 Node/browser tests passed: 484 total, with zero failures, current-host skips, ignores, todos, or cancellations. Four Chromium scenarios and real build, render, dev, and artifact-serve flows passed. |
| Rust coverage | `RUSTC=$(rustup which --toolchain stable rustc) rustup run stable cargo llvm-cov --workspace --all-targets --summary-only -- --test-threads=1` | Isolated exit 0: 91.16% lines, 89.14% functions, 89.65% regions. Builder 94.85% lines, bundler 96.25%, dev/production server 92.15%, protocol 97.30%. These are measured reports, not enforced thresholds. |
| Runtime coverage | `node --test --experimental-test-coverage test/*.test.mjs` in `packages/runtime` | Exit 0: 79.75% lines, 74.78% branches, 88.56% functions. `build-client.mjs` is 93.80% lines, 85.15% branches, and 93.26% functions. |
| Reproducible artifact | two consecutive `pnpm build:example` runs plus canonical file hashing | Both runs produced build id `sha256:e2e8fd9f2f68e29b55c05c759250ab0bb8c08d5afc5704e819438882f9b81411`, the same 25 files, and byte-identical contents. |
| Retry and map repetition | focused tests in separate Node processes | Resolver race passed 20/20. Three-case byte and source-map validation passed 10/10. |
| npm candidates | `pnpm release:verify:npm` | Exit 0: four release-shaped tarballs built and verified. |
| Cargo archives | `pnpm release:verify:cargo` | Exit 0: all 11 crates package; each reports missing repository/homepage/documentation metadata. |
| Dependency/workflow audit | `cargo audit`; `pnpm audit --prod --audit-level high`; `actionlint .github/workflows/*.yml` | Exit 0: no known Cargo or production pnpm vulnerabilities; workflows lint cleanly. |
| Declared MSRV | explicit Rust 1.85 `cargo check --workspace --all-targets` | Exit 0 with the rustup `RUSTC` path pinned. |
| Cross-targets | explicit stable checks for `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-gnu` | Exit 0. Native Windows runtime and symlink behavior remain unexecuted. |
| Test validity | assertion, skip, and production-marker scans plus executable output | No vacuous true/false assertion or ignored Rust test was found. Chrome was present, so all four browser tests executed. The browser files can still skip when Chrome is absent; the three Unix symlink/race tests are gated on Windows. `fake` and `placeholder` matches are negative test fixtures, not product implementations. |
| Secret patterns | tracked names, current tree/diff, and full patch history | No high-confidence key, token, or private-key pattern and no tracked credential-like file was found. Gitleaks, TruffleHog, and cargo-deny are not installed, so this is not a dedicated scanner or license-compliance claim. |

## Runtime Matrix

| Path | Observed result at `b022a76` |
| --- | --- |
| Normal | Real artifact-backed server returned HTTP 200 for `/posts/abc`, rendered `Post abc`, and emitted a JSON access-log 200. |
| Failure | Raw duplicate `Content-Length` action request returned HTTP 400 before application handling. |
| Odd | Raw absolute-form request target returned HTTP 400. An incomplete header under a 200 ms absolute read budget returned HTTP 408. |
| Signal | Direct SIGTERM exited 0; full tests also held accepted renderer work across real SIGINT and SIGTERM before successful drain. |
| Browser | Four sequential real Chromium cases passed. The action test still uses a fixture HTTP server rather than real `ferrite serve`. |
| Cleanup | Attempt staging, publish staging, test subprocesses, browser processes, and direct server reached terminal cleanup. No source or user state was deleted. |
| Rollback | Builder activation tests preserve or restore the prior artifact on failure. This PR is source-only and revertible; direct-directory activation still lacks a versioned atomic release pointer. |

## Independent Review

The independent reviewer first returned `FIX` at `3f845bf` after reproducing the
invalid source maps and destination-symlink escape. It then re-read and executed
the focused suite at exact source head `b022a76` and returned `ACCEPT` with no
High, Medium, or Low findings. It independently reproduced three valid maps,
12 resolvable real sources, two embedded generated sources, both symlink
rejections, 28/28 focused tests, a clean worktree, and the final build id.

Residual path-based TOCTOU requires a process able to rename directories as the
build user and is outside the supported owned-output-directory boundary.
Publication is per-file rather than set-atomic, but supported builder/dev callers
serialize the outer artifact build. This technical verdict is not GitHub approval
and grants no reserved-action authority.

## Backlog Ledger

| Unit | Exact state | Evidence | Disposition and next action |
| --- | --- | --- | --- |
| Draft PR #4 | Base `d10b4e9`; tested local source `b022a76`; remote branch/pull head `55302c0` before final push; no authenticated current review/check rollup | All local gates above and independent `ACCEPT`; no hosted job or attached PR media | `EXTERNALLY_BLOCKED`. Push the existing branch, verify remote convergence, then obtain hosted checks and authenticated PR/media evidence. No merge or draft-promotion authority. |
| Issue #3 | Broad productionization backlog; authenticated issue state unavailable | Remaining license, distribution, hosted staging/capacity, session/auth, distributed replay, atomic release pointer, and external observability are not closed by PR #4 | `EXTERNALLY_BLOCKED` or future scoped backlog. Keep these claims open. |
| Historical `codex/nginx-proof-harness` delta | Original worktree retains one modified verifier and untracked harness/library files; it overlaps the merged framing lane | Files remain preserved; no unique work was deleted or mixed into PR #4 | `SUPERSEDE_CANDIDATE`. Requires separate preservation and close/delete authority. |
| Old module-graph delivery worktree | Clean at `1ad7c32`, four commits behind the remote PR branch | No unique dirty delta | Superseded by the sole mutable PR #4 worktree; leave untouched. |

## External And Productization Gaps

- Git refs prove PR #4 and its pre-push head, but authenticated PR comments,
  draft state, review rollup, branch protection, and checks remain unavailable.
- Hosted Actions previously ended in `startup_failure` before job allocation and
  supplied no status check. Exact local parity does not establish hosted execution.
- No PR screenshot or video is attached through a supported authenticated route.
- There is no root license, `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, or changelog. All four npm source manifests remain
  `private: true`, `UNLICENSED`, and without repository metadata; Cargo declares
  MIT without a root license or repository metadata.
- Registry publication/install, native prebuild publication, public CLI install,
  hosted TLS/proxy/process-manager/CDN/rollback proof, long-duration capacity,
  real browser-to-serve action/payload proof, session-bound CSRF, distributed
  replay, deployment-stable action IDs, and external tracing remain unproven.

## Disposition

The exact source satisfies the local technical proof bar, but draft PR #4 remains
`EXTERNALLY_BLOCKED` as a GitHub delivery unit. It is not claimed
`READY_FOR_RESERVED_ACTION`: hosted checks, authenticated PR state, attached
media, and repository policy are not proven. No merge, close, deploy, publish,
release, spend, settings, credential, production, or live-state action is
authorized by this receipt.
