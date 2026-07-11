# Ferrite Production Readiness Review

Updated: 2026-07-11

## Decision

Ferrite is a credible local framework prototype and a defensible artifact-backed private alpha for trusted developers. It is not ready for unmanaged public production use, a reliability-priced paid beta, or registry-first onboarding.

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
- Bounded production admission, artifact-runner deadlines, generic public production errors, trusted forwarded-IP selection, and static deployment-template checks.
- Staged production artifact installation with activation rollback, strict version/build/path/size/SHA-256/symlink validation, self-contained server modules for every route, parameter-independent browser bundles, verified-byte dynamic HTML/payload/action serving, runtime route-action registration, and manifest-only static asset serving.
- Independent slow artifact requests overlap without a project-wide lock.
- The exact artifact-only container builds and serves a dynamic route and fingerprinted asset as a non-root user with JSON access logs and no runtime workspace package tree.

Explicitly not proven:

- GitHub push, PR review, or remote CI; this checkout has no configured remote.
- Hosted staging behind real TLS, proxy, process manager, CDN, or rollback automation; local container proof does not establish this.
- npm or native prebuild publication and registry installation.
- Cargo registry publication. All 11 local archives now package with versioned internal dependencies, but publish ordering and registry installation are not proven.
- Sustained production load, response-write deadlines, artifact-runner recovery, hosted multi-instance behavior, and rollback under live traffic. The current overlap test is a regression proof, not a capacity benchmark.
- A clean-machine install and serve of the artifact from published packages rather than this monorepo checkout.
- Atomic release activation through a versioned directory or image pointer; direct replacement of an existing build directory has a brief activation window.
- Numeric Rust/JS coverage, mutation testing, or a browser-to-real-`ferrite serve` action/payload test.
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
- [ ] Sustained load tests prove capacity, bounded queues, `503` overload behavior, artifact-runner/worker recovery, and response-write deadlines.
- [ ] A versioned release-directory or image pointer provides atomic activation without the direct-directory rename window.

### P0: Developers Cannot Install A Coherent Release

The source npm packages remain `private: true` and `UNLICENSED`; release staging rewrites them only for local tarball proof. Fake Cargo repository metadata has been removed, all internal path dependencies now carry versions, and all 11 crate archives package locally. The repository still has no root license file or real repository metadata, and no public CLI binary, npm release, native artifact set, or container image exists.

Required exit criteria:

- Owner selects repository visibility, license, package scope, and alpha distribution channel.
- Source/release manifests use one version and one license policy with real repository metadata.
- Cargo packages publish in dependency order and install successfully from the selected registry; local archive creation alone is already proven.
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

1. Add response-write deadlines and sustained overload/artifact-runner recovery proof.
2. Decide license, GitHub repository, and alpha distribution; configure the remote and open a small PR stack.
3. Run the required remote workflow for lint, typecheck, build, full tests, Chromium, artifact-backed example integration, npm verification, Cargo packaging, and native artifacts.
4. Ship one clean-install starter path: `create-ferrite` or `ferrite init`, a pinned toolchain matrix, and one deployable example.
5. Add a single `/builder-lab` demo route that executes one allowlisted real tool and returns the shared Builder AI Lab `proof_receipt` once that schema is authoritative. Do not present a fixture response as model or proof-runtime integration.
6. Deploy the exact candidate artifact to staging behind TLS and the supplied proxy policy. Capture success, malformed input, action rejection, overload, timeout, metrics, logs, restart, and rollback evidence.
7. Onboard one or two trusted developers. Continue only if each reaches a real successful run and can inspect a corresponding failure receipt without maintainer intervention.

## Market Boundary

The near-term offer is a free, support-capped private alpha for teams evaluating a Rust-first TypeScript app framework on internal docs, dashboards, or proof-oriented tools. Do not sell public-production reliability, authenticated mutation safety, React Flight compatibility, or managed hosting yet.

The first paid offer becomes defensible only after clean installation, remote CI, hosted staging, load/timeout evidence, and support/rollback terms are proven on the same release candidate.
