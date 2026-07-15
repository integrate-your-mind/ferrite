# Ferrite cross-root module path proof receipt

## Evidence target

- Recorded: `2026-07-15T01:32:04Z`
- Repository: `git@github.com:integrate-your-mind/ferrite.git`
- Pull request: `#4` (`codex/module-graph-hardening` into `main`)
- Tested and review-target commit: `ce21f6ec421fc57d9319190b8b37fd38e1faccdb`
- Tested tree: `f8f267099990cad51ed9288a927c05d25017b596`
- Executable fix commit: `c69b97cee525c75dce3c338ace4bc537b4eebef9`
- Remote base commit: `d10b4e9c364f533d621a9cd151bbcd1bb161278c`
- The remote branch matched the tested commit before this documentation-only
  receipt was added.

Every executable gate below ran against the exact tested commit and tree. The
later receipt commit changes documentation only.

## Environment

- macOS `26.5.2` (`25F84`), arm64
- Node.js `v24.13.0`
- pnpm `11.7.0`
- Rust `1.95.0 (59807616e 2026-04-14)`
- Cargo `1.95.0 (f2d3ce0bd 2026-03-21)`
- actionlint `1.7.12`
- No container runtime or proof VM was started.

## Reproduction and fix

The JavaScript bundler bridge previously treated any `path.relative()` result
that did not begin with `..` as project-local. Direct `path.win32` probes proved
that this admits Windows cross-drive and UNC paths:

- `relative("C:\\project", "D:\\secret.ts")` returns the absolute path
  `D:\\secret.ts`.
- `relative("C:\\project", "\\\\server\\share\\secret.ts")` returns an
  absolute UNC path.
- Both values passed the old predicate even though `isAbsolute()` returned true.

The production bridge now uses a shared containment helper that rejects the root
itself, parent traversal, and every absolute `relative()` result. The helper takes
an injectable path implementation so Windows behavior is tested on this macOS
host without pretending a POSIX path probe covers Windows. Existing real-project
symlink canonicalization still rejects paths whose resolved target escapes the
project root.

## Exact-source gates

| Command | Exit | Evidence |
| --- | --- | --- |
| Direct `path.win32.relative` reproduction | 0 | The prior predicate accepted cross-drive and UNC absolute results. |
| `node --test packages/runtime/test/project-path.test.mjs` | 0 | POSIX child/root/sibling/parent plus Windows child/cross-drive/UNC cases passed. |
| Focused real symlink-escape regression | 0 | Shipped `build-client.mjs` rejected a dependency whose canonical target escaped the project. |
| `node --test packages/runtime/test/*.test.mjs` | 0 | All 137 runtime tests passed. |
| `git diff --check` | 0 | The source and delivery-contract diffs had no whitespace errors. |
| `pnpm lint` | 0 | Rust formatting, clippy with warnings denied, and package checks passed. |
| `pnpm typecheck` | 0 | TypeScript packages and the seven-route example check passed. |
| `pnpm build` | 0 | Rust workspace, protocol, WASM, runtime, and native Node package built. |
| `pnpm test` | 0 | 29 workflow tests, 15 client-bundler tests, 112 dev-server tests, 137 runtime tests, 20 native-binding/package tests, four Chromium tests, and real example build/render/dev/immutable-serve paths passed. |
| `rustup run stable cargo llvm-cov -p ferrite-client-bundler --summary-only` | 0 | 94.68% regions, 96.36% functions, and 96.05% lines. |
| `rustup run stable cargo llvm-cov -p ferrite-dev-server --summary-only` | 0 | 91.03% regions, 91.55% functions, and 91.46% lines. |
| `pnpm release:verify:npm` | 0 | Four npm tarballs were packed and inspected; `@ferrite/runtime` contained 20 files including the new helper. |
| `pnpm release:verify:cargo` | 0 | All 11 workspace crates packaged. |
| `actionlint` | 0 | All workflow files passed local syntax validation. |
| Tracked-source secret-pattern scan | 0 | No credential or private-key pattern matched. |

## Behavior matrix

| Path | Observed result |
| --- | --- |
| Normal | POSIX and Windows descendants remain project modules and retain deterministic graph ordering. |
| Failure | Root, sibling, parent, cross-drive, UNC, and canonical symlink escapes are rejected before graph emission. |
| Odd | A Windows path on the same drive is accepted only when `path.win32.relative()` proves it is a strict descendant. |
| Compatibility | No public API or manifest changed. The shared helper uses the active platform implementation in production and an injected implementation only in its platform regression. |
| Runtime/browser | Four sequential Chromium tests passed. The real CLI built seven routes and served `/posts/abc` through dev and immutable artifact modes with build id `sha256:e68cf8acdd45c23bb4523689a1ecb79640ca766bec6634268fe8877c6ba9b1fd`. |
| Cleanup | All owned commands terminated. Generated build, coverage, package, and native outputs were removed after results and hashes were recorded. |

## Test-validity audit

- The failure was reproduced with Node's production `path.win32` implementation,
  not a hand-written path parser.
- The regression exercises the exported helper with both `path.posix` and
  `path.win32`, so it can fail on this host if either contract regresses.
- The real symlink test invokes shipped `build-client.mjs` in a temporary project
  and observes the production diagnostic.
- Full Rust, JavaScript, Chromium, example, npm, and Cargo paths prevent the
  helper-only unit test from standing in for integration proof.

## Hosted workflow state

- Tested-head push run
  [29381756499](https://github.com/integrate-your-mind/ferrite/actions/runs/29381756499)
  ended in `startup_failure` with zero jobs.
- Tested-head pull-request run
  [29381758198](https://github.com/integrate-your-mind/ferrite/actions/runs/29381758198)
  ended in `startup_failure` with zero jobs.
- Both events were assigned to GitHub's deleted pseudo-workflow `BuildFailed`
  (`workflow_id: 311895905`) and produced no job logs or PR status checks.
- The real workflow files pass `actionlint`, but no hosted job executed. Local
  proof is not represented as hosted proof.

## Independent review state

- The two earlier actionable inline findings remain resolved; the current
  unresolved review-thread count is zero.
- One bounded read-only current-head review was requested through the tier router
  as `gpt-5.6-sol`, `ultra`, standard service tier.
- The router ended after its 120-second bound with exit `124`, phase `timeout`,
  child thread `019f6364-5d9b-72f0-b1de-2b7eced99089`, and turn
  `019f6364-66c0-7c31-9bd2-ae96c0877da7`.
- The child returned no effective-tier receipt, findings, or verdict, and its
  ephemeral thread was no longer readable afterward. No replacement was launched.
- Therefore there is no independent current-head verdict and no `READY` claim.

## File hashes

```text
bdbfa60a83cabd59fa5e8fc5b1ed193b08480549826f19361c41cc853a94b720  packages/runtime/bin/build-client.mjs
900ae7e28ef2cdd84b9f5c9553d35d92938b653f2ef7f8da6ef747b339475866  packages/runtime/bin/project-path.mjs
31a16a7e318a8dcd8f4cd7761ec2f1697e90311d6457d945a8a28df392e0a8b6  packages/runtime/test/project-path.test.mjs
2d0e264628360a15ee47aebad9448782737f05e9a0ec09fb3f3a90703e4abbb7  packages/runtime/test/render-page.test.mjs
0200c455bf1f3732d9a2f1f61c379056b09ed34a90024ec9e9a8744413415740  docs/architecture.md
7d03a92bd3ea536ef99e54c6a94dc5521efad3953b3d1be6dfb8dcee73360e64  docs/production-readiness-review-2026-07-10.md
094bb9c48b87c0ed142a63e16aae5d476523ed0f1b4489fe6e848822d74e8cc6  dist/npm-packages/npm-package-report.json
```

The npm report is generated and ignored. Its hash binds the inspected package
inventory; the generated output was then removed.

## Alignment and delivery state

- The active durable goal was re-read as `active`. The supported goal API cannot
  rewrite an unfinished objective, so no false completion or replacement occurred.
- The existing production-readiness source now names PR #4 as the one delivery
  unit, records one mutable owner, requires exact-head proof, and explicitly
  reserves merge, deploy, release, publish, settings, credentials, billing, and
  proof-VM recreation for action-specific authorization from Romy.
- Cargo packaging succeeds but manifests still warn about missing registry-grade
  documentation, homepage, or repository metadata.
- No fresh integrated nginx run or media attachment is claimed for this
  source-level path-containment change; the complete Rust HTTP and Chromium suites
  remain green.
- Disposition: **FIX (proof incomplete)**. Known local defects are fixed, but a
  current-head independent verdict and hosted job execution are absent.
- `READY`: no.
- `MERGE_ELIGIBLE`: no.
- `AUTHORIZED_TO_MERGE`: no. No current action-specific merge authority exists.
- Rollback is a revert of `ce21f6e` for the alignment documentation and `c69b97c`
  for the cross-root fix; earlier module-graph commits remain separately revertible.
- No migration, secret, feature flag, production data, or persistent user state is
  involved.
- No merge, deployment, publication, release, repository-setting change, or
  proof-VM recreation occurred.
