# Ferrite Production Readiness Review

Reviewed: 2026-07-10

## Decision

Ferrite is a credible local framework prototype and a defensible source-checkout private alpha for trusted developers. It is not ready for unmanaged public production use, a reliability-priced paid beta, or registry-first onboarding.

The highest-return work is no longer broad React or Next.js parity. It is the production path between `ferrite build`, `ferrite serve`, a clean developer install, remote CI, and one hosted Builder AI Lab proof workflow.

## Current Evidence

Locally proven on `codex/protocol-wasm-validation`:

- Rust formatting and clippy with warnings denied.
- TypeScript package checks and example app typechecking.
- Rust and JavaScript/TypeScript builds.
- Full workspace tests, including real loopback HTTP tests.
- Four sequential Chromium tests.
- Real example static build, render fixture, dev one-shot, and production serve one-shot.
- npm release-shaped tarball creation and clean local install verification for four JS-facing packages.
- Bounded production admission, renderer and bundler deadlines, generic public production errors, trusted forwarded-IP selection, and static deployment-template checks.

Explicitly not proven:

- GitHub push, PR review, or remote CI; this checkout has no configured remote.
- Hosted staging behind real TLS, proxy, process manager, CDN, or rollback automation.
- npm or native prebuild publication and registry installation.
- Cargo workspace publication. `cargo package --workspace --allow-dirty --no-verify` stops because internal path dependencies do not declare versions.
- A self-contained production server artifact; `ferrite serve` still executes source renderer and bundler subprocesses at request time.
- Parallel route execution; matched requests still lock one shared `ProductionProject`.
- Numeric Rust/JS coverage, mutation testing, or a browser-to-real-`ferrite serve` action/payload test.
- Session-bound CSRF rotation, distributed replay storage, deployment-stable action IDs, first-class auth integration, or external tracing/audit sinks.
- A Builder AI Lab model-gateway call or shared `proof_receipt` implementation.

## Blocking Findings

### P0: Production Serve Is Not Artifact-Backed

`ferrite build` emits static output and manifests, but `ferrite serve` rescans source and invokes Node rendering, metadata, action-manifest discovery, and client bundling during requests. The production adapter also protects the entire `ProductionProject` behind one mutex. The new admission and subprocess limits prevent unbounded growth, but they do not provide production throughput or immutable-release behavior.

Required exit criteria:

- Build emits a versioned server manifest, prebuilt server modules, action registry, and content-addressed client assets.
- Serve accepts a build directory or release artifact and fails closed on missing or incompatible files.
- Ordinary requests do not invoke esbuild or rediscover action manifests.
- Independent route requests can execute concurrently without a global project lock.
- Load tests prove bounded queues, `503` overload behavior, subprocess/worker recovery, and response-write deadlines.

### P0: Developers Cannot Install A Coherent Release

The source npm packages remain `private: true` and `UNLICENSED`; release staging rewrites them only for local tarball proof. Cargo points at `https://example.invalid/ferrite`, the repository has no root license file, and Cargo packaging fails after the first crate because internal path dependencies omit versions. No public CLI binary, npm release, native artifact set, or container image exists.

Required exit criteria:

- Owner selects repository visibility, license, package scope, and alpha distribution channel.
- Source/release manifests use one version and one license policy with real repository metadata.
- Cargo packages include versioned internal dependencies and package successfully.
- Native prebuilds build and load on every advertised platform in hosted CI.
- One clean machine installs the exact candidate artifacts and runs `check`, `build`, and `serve` without a monorepo checkout.

### P1: Green Tests Overstate Some Integration Surfaces

The browser action test uses a fixture HTTP server and canned action response; payload navigation uses hand-authored packets. Deployment verification mainly checks template text. Native package install smoke omits optional dependencies and does not load a registry-installed addon. Several Rust adapter tests use generated scripts that prove argument and packet plumbing, not compatibility with the shipped runner.

Required exit criteria:

- Browser tests launch a real `ferrite serve` process for HTML, payload, stream, and server-action success/failure paths.
- CI fails when the required browser is absent rather than silently skipping proof.
- Container/proxy smoke runs automatically against the candidate image.
- Numeric branch coverage is reported, with thresholds focused on protocol, routing, action security, and production serving.
- Published native optional packages are installed and loaded on each supported target.

### P1: Security Is Private-Alpha Only

This review fixed unbounded socket admission, an unbounded bundler subprocess, raw production error disclosure, forged forwarded client IPs in the supplied nginx topology, public proxying of metrics, and common secret-file inclusion in Docker build context. Remaining blockers are session-bound CSRF rotation, app-owned authentication guidance, distributed replay storage, duplicate-header/request-smuggling hardening, response-write timeouts, and external audit/tracing sinks.

### P1: Remote And Hosted Evidence Is Missing

Committed workflows verify npm tarballs and native prebuild dry-runs, but no general full-gate workflow has run remotely and there is no PR or hosted deployment. Local green commands cannot substitute for exact-commit CI, registry, or staging evidence.

## Fastest Developer Launch

1. Freeze parity work and implement artifact-backed serving plus real concurrency.
2. Decide license, GitHub repository, and alpha distribution; configure the remote and open a small PR stack.
3. Add one required remote workflow for lint, typecheck, build, full tests, Chromium, example integration, npm verification, Cargo packaging, and native artifacts.
4. Ship one clean-install starter path: `create-ferrite` or `ferrite init`, a pinned toolchain matrix, and one deployable example.
5. Add a single `/builder-lab` demo route that executes one allowlisted real tool and returns the shared Builder AI Lab `proof_receipt` once that schema is authoritative. Do not present a fixture response as model or proof-runtime integration.
6. Deploy the exact candidate artifact to staging behind TLS and the supplied proxy policy. Capture success, malformed input, action rejection, overload, timeout, metrics, logs, restart, and rollback evidence.
7. Onboard one or two trusted developers. Continue only if each reaches a real successful run and can inspect a corresponding failure receipt without maintainer intervention.

## Market Boundary

The near-term offer is a free, support-capped private alpha for teams evaluating a Rust-first TypeScript app framework on internal docs, dashboards, or proof-oriented tools. Do not sell public-production reliability, authenticated mutation safety, React Flight compatibility, or managed hosting yet.

The first paid offer becomes defensible only after clean installation, remote CI, hosted staging, artifact-backed serving, and support/rollback terms are proven on the same release candidate.
