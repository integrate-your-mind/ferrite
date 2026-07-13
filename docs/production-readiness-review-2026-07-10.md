# Ferrite Production Readiness Review

Updated: 2026-07-13

## Decision

Ferrite is a credible local framework prototype and a defensible artifact-backed private alpha for trusted developers. It is not ready for unmanaged public production use, a reliability-priced paid beta, or registry-first onboarding.

The highest-return work is no longer broad React or Next.js parity. It is the production path between `ferrite build`, `ferrite serve`, a clean developer install, remote CI, and one hosted Builder AI Lab proof workflow.

## Current Evidence

Locally proven through the current `codex/http-framing-hardening` PR branch:

- Rust formatting and clippy with warnings denied.
- TypeScript package checks and example app typechecking.
- Rust and JavaScript/TypeScript builds.
- Full workspace tests, including real loopback HTTP tests.
- Four sequential Chromium tests.
- Real example static build, render fixture, dev one-shot, and production serve one-shot.
- npm release-shaped tarball creation plus clean external-directory `check`, `build`, and artifact-serve verification for four JS-facing packages and a copied candidate CLI.
- Bounded production admission, artifact-runner deadlines, generic public production errors, trusted forwarded-IP selection, and static deployment-template checks.
- Staged production artifact installation with activation rollback, strict version/build/path/size/SHA-256/symlink validation, self-contained server modules for every route, parameter-independent browser bundles, verified-byte dynamic HTML/payload/action serving, runtime route-action registration, and manifest-only static asset serving.
- Independent slow artifact requests overlap without a project-wide lock.
- The exact artifact-only container builds and serves a dynamic route and fingerprinted asset as a non-root user with JSON access logs and no runtime workspace package tree.
- A self-contained harness builds that production image and runs it behind official nginx 1.29.3 selected by immutable multi-platform index digest on an isolated Docker network. It exercises 37 raw HTTP/1 cases, four negotiated HTTP/2 cases, five fail-closed controls, and handled-path cleanup. Release evidence is valid only when the harness records a clean exact-head source state.
- Production sockets enforce a configurable absolute response-write deadline across fixed, gzip, and chunked output; parse errors, overload rejection, and shutdown drain use bounded writers, and a real stalled-reader test proves typed timeout failure.
- An artifact-backed real-socket saturation test holds both workers, receives six prompt `503` responses, releases the work, and proves a later request succeeds; a separate single-worker test proves a failed artifact-runner subprocess returns a generic `500` and the next request succeeds.
- A bounded artifact-backed mixed-load soak repeats four-worker slow-reader saturation and barrier-synchronized concurrent load waves, proves write-deadline truncation, complete overload `503` delivery, no false `408` responses for complete requests, post-saturation runner failure recovery, fixed rejection-worker limits, runner lifecycle cleanup, and bounded joined shutdown.

Explicitly not proven:

- GitHub-hosted job execution or a distinct external approval. The remote and PR #2 exist, but exact-head Actions runs end in `startup_failure` with zero allocated jobs and no status checks.
- Hosted staging behind real TLS, proxy, process manager, CDN, or rollback automation; local container proof does not establish this.
- npm or native prebuild publication and registry installation.
- Cargo registry publication. All 11 local archives now package with versioned internal dependencies, but publish ordering and registry installation are not proven.
- Hosted capacity, long-duration soak, host-process supervisor recovery, hosted multi-instance behavior, and rollback under live traffic. The local mixed-load soak is a bounded regression proof, not a throughput or capacity benchmark.
- A clean-machine install from published packages and a publicly distributed CLI rather than locally packed candidates and a copied CLI binary.
- Atomic release activation through a versioned directory or image pointer; direct replacement of an existing build directory has a brief activation window.
- Workspace-wide Rust/JS branch thresholds, mutation testing, or a browser-to-real-`ferrite serve` action/payload test. A one-time local `ferrite-dev-server` coverage run reports 90.12% line, 90.20% function, and 89.58% region coverage, but it is not yet a committed CI threshold.
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

The source npm packages remain `private: true` and `UNLICENSED`; release staging rewrites them only for local tarball proof. Fake Cargo repository metadata has been removed, all internal path dependencies now carry versions, and all 11 crate archives package locally. The repository still has no root license file or real repository metadata, and no public CLI binary, npm release, native artifact set, or container image exists.

Required exit criteria:

- Owner selects repository visibility, license, package scope, and alpha distribution channel.
- Source/release manifests use one version and one license policy with real repository metadata.
- Cargo packages publish in dependency order and install successfully from the selected registry; local archive creation alone is already proven.
- Native prebuilds build and load on every advertised platform in hosted CI.
- One clean machine installs the exact published artifacts and public CLI; the equivalent local-candidate flow is now proven outside the monorepo.

### P1: Green Tests Overstate Some Integration Surfaces

The browser action test uses a fixture HTTP server and canned action response; payload navigation uses hand-authored packets. Deployment verification mainly checks template text. The npm clean install allows optional dependencies so esbuild receives its platform binary, but it does not load a registry-installed Ferrite native addon. Several Rust adapter tests use generated scripts that prove argument and packet plumbing, not compatibility with the shipped runner.

Required exit criteria:

- Browser tests launch a real `ferrite serve` process for HTML, payload, stream, and server-action success/failure paths.
- CI fails when the required browser is absent rather than silently skipping proof.
- The candidate-image proxy smoke remains green locally and is committed to the Verify workflow; the hosted job must actually execute before this exit criterion is complete.
- Numeric branch coverage is reported, with thresholds focused on protocol, routing, action security, and production serving.
- Published native optional packages are installed and loaded on each supported target.

### P1: Security Is Private-Alpha Only

This review and PR #2 fixed unbounded socket admission, an unbounded bundler subprocess, raw production error disclosure, forged forwarded client IPs in the supplied nginx topology, public proxying of metrics, common secret-file inclusion in Docker build context, unbounded response writes, and ambiguous duplicate-header/request-framing behavior. Remaining blockers are session-bound CSRF rotation, app-owned authentication guidance, distributed replay storage, deployment-stable action IDs, and external audit/tracing sinks.

### P1: Remote And Hosted Evidence Is Missing

PR #2 and the general Verify workflow now exist, including the candidate-image nginx harness, but every exact-head Actions attempt has failed before job allocation. There is no hosted deployment. Local exact-commit proof cannot substitute for real hosted CI, registry, or staging evidence.

## Fastest Developer Launch

1. Define throughput and latency targets, then run hosted and long-duration capacity tests around the completed bounded mixed-load regression soak.
2. Resolve the GitHub Actions startup/allocation blocker and obtain a distinct review of PR #2 without bypassing checks or repository policy.
3. Run the required remote workflow for lint, typecheck, build, full tests, Chromium, artifact-backed example integration, pinned-nginx candidate-image proof, npm verification, Cargo packaging, and native artifacts.
4. Publish the locally proven `ferrite init` starter path with a public CLI binary and pinned toolchain matrix, then validate it on a clean machine.
5. Add a single `/builder-lab` demo route that executes one allowlisted real tool and returns the shared Builder AI Lab `proof_receipt` once that schema is authoritative. Do not present a fixture response as model or proof-runtime integration.
6. Deploy the exact candidate artifact to staging behind TLS and the supplied proxy policy. Capture success, malformed input, action rejection, overload, timeout, metrics, logs, restart, and rollback evidence.
7. Onboard one or two trusted developers. Continue only if each reaches a real successful run and can inspect a corresponding failure receipt without maintainer intervention.

## Market Boundary

The near-term offer is a free, support-capped private alpha for teams evaluating a Rust-first TypeScript app framework on internal docs, dashboards, or proof-oriented tools. Do not sell public-production reliability, authenticated mutation safety, React Flight compatibility, or managed hosting yet.

The first paid offer becomes defensible only after clean installation, remote CI, hosted staging, load/timeout evidence, and support/rollback terms are proven on the same release candidate.
