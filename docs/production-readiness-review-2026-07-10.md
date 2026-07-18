# Ferrite Production Readiness Review

Updated: 2026-07-18

## Decision

Ferrite is a credible local framework prototype and a defensible artifact-backed private alpha for trusted developers. It is not ready for unmanaged public production use, a reliability-priced paid beta, or registry-first onboarding.

The highest-return work is no longer broad React or Next.js parity. It is the production path between `ferrite build`, `ferrite serve`, a clean developer install, remote CI, and one hosted Builder AI Lab proof workflow.

## Current Delivery Contract

- Delivery unit: draft PR #4 on `codex/module-graph-hardening`.
- Owner: the current Ferrite module-graph task; no second mutable owner may edit the same branch or PR evidence.
- Disposition vocabulary: `FIX_NOW`, `READY_FOR_RESERVED_ACTION`, `SUPERSEDE_CANDIDATE`, or `EXTERNALLY_BLOCKED`, based on deterministic module-graph construction, runtime-edge discovery, cycle diagnostics, invalidation behavior, and delivery evidence at the exact head.
- Required evidence: normal, failure, odd, backward-compatibility, and cleanup paths; lint, typecheck, build, tests, focused coverage, package verification, applicable runtime/browser proof, hosted-check state, and an independent current-head review before any `READY` claim.
- Allowed actions in the current owner task: inspect, edit, test, and commit a local checkpoint. Pushing or authenticated PR updates require a credential-authorized owner and are not performed by this task.
- Reserved actions: merge, deploy, release, publish, repository settings, credentials, billing, and recreation of the removed `ferrite-proof` VM. Generic instructions to continue, finish, or unblock do not authorize a reserved action; Romy must authorize that action explicitly.
- Draft rule: PR #4 remains draft until every required local gate passes, the exact remote head and proof receipt agree, and no actionable review finding remains. Missing hosted execution or authenticated PR state is labeled `EXTERNALLY_BLOCKED`; it is not silently treated as local failure or readiness.

## July 18 PR Backlog Ledger

PR #4 is the sole open delivery unit known from the last authenticated inventory. Its base is `main` at `d10b4e9c364f533d621a9cd151bbcd1bb161278c`. The accepted local source is `308ad586b5825add2b5a639176573adc6c887861`; the cached remote delivery branch is `99fc7c6e4287f360906efcaa8424899acc204d14`, cached pull head is `55302c0810f0e1fc2e15d3867451876ccd6203c3`, and cached merge ref is `ea92d87688c38476e34314e943f6df2e54a28511`. These cached refs do not prove current GitHub state. The local source is six commits ahead of the cached remote delivery branch. The dedicated mutable worktree is `codex/module-graph-backlog-fix`; no other owner may edit this delivery unit.

| Unit | Intent and dependency | Review/CI debt | Evidence state | Disposition |
| --- | --- | --- | --- | --- |
| Draft PR #4 | Compiler-owned runtime graph, cycle diagnostics, resolver/config invalidation, then dependent slow-client, action-security, deployment, shutdown, reproducibility, and output-publication fixes | The sole bounded reviewer returned final `ACCEPT` with no blocking security, build-integrity, or portability finding at exact source `308ad58`. GitHub still has no proven executed status check; hosted Actions previously ended in `startup_failure` before job allocation. Authenticated comments, draft state, branch protection, and checks cannot be refreshed without crossing the credential boundary. | Source `308ad58` passes lint, typecheck, build, 509 tests, package archives, dependency/workflow scans, Rust 1.85, Linux/Windows cross-checks, coverage, 10 real-Chrome scenarios, real example build/dev/serve, real production action success/failure, same-head byte reproducibility, snapshot/invalidation tests, bounded slow-client timeout handling, and descendant cleanup. The cached remote branch is six commits behind. Receipt: `docs/proof-receipts/2026-07-18T110657Z-308ad58-pr4-backlog-final.md`. | `EXTERNALLY_BLOCKED`. Local source satisfies the technical bar, but the remote is stale and hosted checks, authenticated PR state, and attached media remain unproven. No merge or draft-promotion authority is inferred. |
| Issue #3 | Cached prior inventory describes a broad productionization backlog; PR #4 closes only its graph, request-budget, action-error, and shutdown subfindings | Current authenticated issue state is unavailable. The remaining license, distribution, hosted staging, hosted capacity, session/auth, distributed replay, atomic release-pointer, and external observability work must stay open after PR #4. | Local proof cannot close hosted or release claims. | `EXTERNALLY_BLOCKED` or future scoped backlog, depending on each subfinding; not a fresh authenticated GitHub inventory and not a reason to add scope to PR #4. |
| Historical `codex/nginx-proof-harness` local delta | Earlier nginx evidence already represented by merged HTTP-framing work and preserved local files | It overlaps the completed framing lane and must not be mixed into PR #4. | Preserved in its original worktree; no unique file was deleted or moved. | `SUPERSEDE_CANDIDATE`, pending a separate preservation decision with close/delete authority. |

## Current Evidence

Historically proven across the merged HTTP-framing lane and the current PR #4 branch:

- Exact source SHA `308ad586b5825add2b5a639176573adc6c887861` and tree `b7a43134b1dca199fbfb4eb6d812151c6dd4b9aa` pass the July 18 local proof packet and independent review.
- Rust formatting and clippy with warnings denied.
- TypeScript package checks and example app typechecking.
- Rust and JavaScript/TypeScript builds.
- Full workspace tests, including real loopback HTTP tests.
- Ten sequential real-Chrome tests with zero skips, including real production serve and server-action success/failure.
- Real example static build, render fixture, dev one-shot, and production serve one-shot.
- Two complete same-source builds produce the same build id, 25-file inventory, and bytes. Published maps resolve 12 real sources, embed two generated sources, and contain no staging paths.
- Client output publication rejects directory and file symlink escapes and cleans failed attempt/publish staging.
- npm release-shaped tarball creation plus clean external-directory `check`, `build`, and artifact-serve verification for four JS-facing packages and a copied candidate CLI.
- Bounded production admission, artifact-runner deadlines, generic public production errors, trusted forwarded-IP selection, and static deployment-template checks.
- Staged production artifact installation with activation rollback, strict version/build/path/size/SHA-256/symlink validation, self-contained server modules for every route, parameter-independent browser bundles, verified-byte dynamic HTML/payload/action serving, runtime route-action registration, and manifest-only static asset serving.
- Independent slow artifact requests overlap without a project-wide lock.
- The exact artifact-only container builds and serves a dynamic route and fingerprinted asset as a non-root user with JSON access logs and no runtime workspace package tree.
- A self-contained harness exports a clean exact Git commit into an immutable context, labels the resulting production image with the revision/tree, and runs it behind official nginx 1.29.3 selected by immutable multi-platform index digest on an isolated Docker network. It exercises 43 raw HTTP/1 cases, seven negotiated HTTP/2 cases, five proxy-level no-upstream framing checks, nine proxy-level no-upstream malformed-target checks, five fail-closed controls, and handled-path cleanup.
- Production sockets enforce a configurable absolute response-write deadline across fixed, gzip, and chunked output; parse errors, overload rejection, and shutdown drain use bounded writers, and a real stalled-reader test proves typed timeout failure.
- An artifact-backed real-socket saturation test holds both workers, receives six prompt `503` responses, releases the work, and proves a later request succeeds; a separate single-worker test proves a failed artifact-runner subprocess returns a generic `500` and the next request succeeds.
- A bounded artifact-backed mixed-load soak repeats four-worker slow-reader saturation and barrier-synchronized concurrent load waves, proves write-deadline truncation, complete overload `503` delivery, no false `408` responses for complete requests, post-saturation runner failure recovery, fixed rejection-worker limits, runner lifecycle cleanup, and bounded joined shutdown.
- The declared Rust 1.85 workspace floor passes all targets; `ferrite-cli` also cross-checks for `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-gnu`. Native Windows runtime signal behavior remains unproven.
- Exact-source dependency scans report no known Cargo or production pnpm vulnerabilities; Actionlint, tracked/history secret-pattern scans, and the current-delta secret scan pass.

Explicitly not proven:

- GitHub-hosted job execution or a distinct external approval. Draft PR #4 exists, but exact-head Actions attempts have ended in `startup_failure` with zero allocated jobs and no status checks.
- Hosted staging behind real TLS, proxy, process manager, CDN, or rollback automation; local container proof does not establish this.
- npm or native prebuild publication and registry installation.
- Cargo registry publication. All 11 local archives now package with versioned internal dependencies, but publish ordering and registry installation are not proven.
- Hosted capacity, long-duration soak, host-process supervisor recovery, hosted multi-instance behavior, and rollback under live traffic. The local mixed-load soak is a bounded regression proof, not a throughput or capacity benchmark.
- A clean-machine install from published packages and a publicly distributed CLI rather than locally packed candidates and a copied CLI binary.
- Atomic release activation through a versioned directory or image pointer; direct replacement of an existing build directory has a brief activation window.
- Enforced workspace-wide Rust/JS coverage thresholds, mutation testing, or production SPA payload navigation. Real browser-to-`ferrite serve` HTML, hydration, full-document navigation, and server-action success/failure are proven; the SPA payload navigator still uses a fixture because generated production bundles do not expose its private hydration root handle. The final July 18 report measures Rust at 91.11% lines, 89.08% functions, and 89.64% regions; Node runtime tests measure 80.56% lines, 76.28% branches, and 88.95% functions, with `build-client.mjs` at 93.92% lines. These are reports, not committed fail-under thresholds.
- Session-bound CSRF rotation, distributed replay storage, deployment-stable action IDs, first-class auth integration, or external tracing/audit sinks.
- A Builder AI Lab model-gateway call or shared `proof_receipt` implementation.

## Blocking Findings

### Resolved Locally: Production Serve Is Artifact-Backed

`ferrite build` now stages and installs `ferrite-server.json`, one self-contained server module and parameter-independent browser bundle per route, optional prerenders, build-observed action metadata, and SHA-256/size records. Failed activation restores the prior output when rollback succeeds, but direct directory replacement is not an atomic release-pointer swap. `ferrite serve` is artifact-only outside tests, validates and retains the complete artifact before startup, and passes verified module bytes to `render-artifact.mjs`, which has no esbuild dependency. Immutable route state is shared directly; replay nonces alone use a narrow mutex. A source/artifact-removal integration test covers bundled dependencies, dynamic HTML, payloads, conditional actions, and assets, and an overlap-event test proves concurrent execution.

Required exit criteria:

- [x] Build emits a versioned server manifest, self-contained server modules, build-observed action metadata, and content-addressed client assets.
- [x] Serve accepts a build directory and fails closed on missing, incompatible, unsafe, or integrity-mismatched files.
- [x] Ordinary requests do not import esbuild, scan source, or rediscover action manifests.
- [x] Independent route requests execute concurrently without a global project lock.
- [x] Production fixed, gzip, chunked, parse-error, overload, and shutdown-drain responses use a configurable absolute write deadline, with real stalled-reader timeout proof.
- [x] Controlled saturation proves bounded `503` responses, recovered worker capacity, and successful single-worker reuse after an artifact-runner subprocess failure.
- [x] A bounded mixed-load soak proves concurrent slow-reader deadlines, overload delivery, false-`408` absence, cleanup, and post-saturation recovery.
- [ ] Hosted and long-duration load tests establish throughput, latency, and capacity targets.
- [ ] A versioned release-directory or image pointer provides atomic activation without the direct-directory rename window.

### P0: Developers Cannot Install A Coherent Release

The source npm packages remain `private: true` and `UNLICENSED`; release staging rewrites them only for local tarball proof. Fake Cargo repository metadata has been removed, all internal path dependencies now carry versions, and all 11 crate archives package locally. The repository still has no root license, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, changelog, or real repository metadata, and no public CLI binary, npm release, native artifact set, or container image exists.

Required exit criteria:

- Owner selects repository visibility, license, package scope, and alpha distribution channel.
- Source/release manifests use one version and one license policy with real repository metadata.
- Cargo packages publish in dependency order and install successfully from the selected registry; local archive creation alone is already proven.
- Native prebuilds build and load on every advertised platform in hosted CI.
- One clean machine installs the exact published artifacts and public CLI; the equivalent local-candidate flow is now proven outside the monorepo.

### P1: Green Tests Overstate Some Integration Surfaces

Real Chrome now covers HTML, hydration, full-document navigation, and server-action success/failure against a real `ferrite serve` process. SPA payload navigation still uses hand-authored packets because the generated production bundle has no public path to the navigator's private hydration root handle. Deployment verification mainly checks template text. The npm clean install allows optional dependencies so esbuild receives its platform binary, but it does not load a registry-installed Ferrite native addon. Several Rust adapter tests use generated scripts that prove argument and packet plumbing, not compatibility with the shipped runner.

Required exit criteria:

- [x] Browser tests launch a real `ferrite serve` process for HTML, hydration, full-document navigation, and server-action success/failure paths.
- [ ] Production SPA payload and stream navigation run through the generated browser bundle rather than a fixture packet.
- CI fails when the required browser is absent rather than silently skipping proof.
- The candidate-image proxy smoke remains green locally and is committed to the Verify workflow; the hosted job must actually execute before this exit criterion is complete.
- Numeric branch coverage is reported, with thresholds focused on protocol, routing, action security, and production serving.
- Published native optional packages are installed and loaded on each supported target.

### P1: Security Is Private-Alpha Only

The merged HTTP-framing work and PR #4 backlog fixes address unbounded socket admission, an unbounded bundler subprocess, raw production error disclosure, forged forwarded client IPs in the supplied nginx topology, public proxying of metrics, common secret-file inclusion in Docker build context, unbounded response writes, ambiguous duplicate-header/request-framing behavior, renewable trickle-read timeouts, unbounded replay nonce state, incomplete production source snapshots, and missing CLI signal drain/cleanup. Remaining blockers are session-bound CSRF rotation, app-owned authentication guidance, distributed replay storage, deployment-stable action IDs, and external audit/tracing sinks.

### P1: Remote And Hosted Evidence Is Missing

The general Verify workflow and candidate-image nginx harness exist, but every relevant hosted Actions attempt has failed before job allocation. There is no hosted deployment. Local exact-commit proof cannot substitute for real hosted CI, registry, or staging evidence.

## Fastest Developer Launch

1. Select and add the root license, align Cargo/npm metadata, and add the public security, contribution, conduct, changelog, and support policies. Without this, public visibility is source-available rather than a defensible open-source launch.
2. Push the proven PR #4 head, resolve the GitHub Actions startup/allocation blocker, and obtain real hosted checks without bypassing repository policy.
3. Run the required remote workflow for lint, typecheck, build, full tests, Chromium, artifact-backed example integration, pinned-nginx candidate-image proof, npm verification, Cargo packaging, and native artifacts.
4. Ship the locally proven `ferrite init` path through one supported source-build developer-preview installer, then validate the exact instructions on a clean machine. Keep registry publication separate until package policy is approved.
5. Define throughput and latency targets, then run hosted and long-duration capacity tests around the completed bounded mixed-load regression soak.
6. Deploy the exact candidate artifact to staging behind TLS and the supplied proxy policy. Capture success, malformed input, action rejection, overload, timeout, metrics, logs, restart, and rollback evidence.
7. Onboard one to three experienced design partners. Continue only if each reaches a real successful run and can inspect a corresponding failure receipt without maintainer intervention.

## Market Boundary

The near-term offer is a free, support-capped private alpha for teams evaluating a Rust-first TypeScript app framework on internal docs, dashboards, or proof-oriented tools. Do not sell public-production reliability, authenticated mutation safety, React Flight compatibility, or managed hosting yet.

The first paid offer becomes defensible only after clean installation, remote CI, hosted staging, load/timeout evidence, and support/rollback terms are proven on the same release candidate.
