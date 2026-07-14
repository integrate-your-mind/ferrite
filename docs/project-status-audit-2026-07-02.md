# Project Status Audit: 2026-07-02

> Historical snapshot: this audit records the repository state on 2026-07-02. As of 2026-07-13, `origin` is configured, GitHub PR #2 is open, and exact-head local build/test/package/nginx receipts exist. Hosted Actions still ends in `startup_failure` before allocating jobs, so remote CI remains unproven. Current delivery state is tracked in PR #2 and the newer proof receipts; unchecked remote/PR items below describe the original audit date rather than current absence.

This audit records the current local state of the Ferrite framework on branch
`codex/protocol-wasm-validation`.

Evidence used:

- `git log --oneline --reverse --all --decorate`
- `git status --short --branch`
- `git remote -v`
- `README.md`
- `docs/architecture.md`
- `docs/milestone-001-proof.md` through `docs/milestone-089-proof.md`
- `package.json`
- representative tests under `packages/`, `scripts/`, and `crates/`
- live `npm pack --json` tarball inspection plus clean external-directory candidate CLI workflow proof for the JS-facing packages

## Current External State

- [x] Local branch exists: `codex/protocol-wasm-validation`.
- [x] Local milestone proof docs exist through milestone 089.
- [x] Working tree docs were audited and refreshed locally.
- [ ] Git remote is configured. `git remote -v` is empty in this checkout.
- [ ] Work has been pushed to GitHub from this checkout.
- [ ] A pull request exists for this checkout's current branch.
- [ ] Remote CI has run for this checkout's current branch.

## Completed Milestone Checklist

- [x] 001: Rust workspace baseline, TypeScript runtime facade, route types, CLI, and Node-to-Rust render fixture.
- [x] 002: Browser DOM `mount()`, `useState`, root updates, events, and unmount.
- [x] 003: DOM hydration over matching server HTML with mismatch failures.
- [x] 004: Rust dev server route serving, manifests, reload polling, and one-request TCP proof.
- [x] 005: Production build shell output, build manifest, and generated route types.
- [x] 006: TSX page execution through the JS page runner and Rust SSR.
- [x] 007: Client bundling, CSS/assets, source maps, dev static serving, and build injection.
- [x] 008: `generateStaticParams()` for normal dynamic routes.
- [x] 009: In-place DOM patching and keyed child reconciliation.
- [x] 010: `useEffect()` with dependency cleanup and server no-op behavior.
- [x] 011: App-directory layout discovery and layout-wrapped SSR/bundling.
- [x] 012: `useRef()`, `useMemo()`, and `useCallback()`.
- [x] 013: `startTransition()`, `useTransition()`, and `useDeferredValue()`.
- [x] 014: `useLayoutEffect()` ordering and cleanup.
- [x] 015: Page/layout metadata with title and description.
- [x] 016: Catch-all and optional catch-all params across dev/build/runtime.
- [x] 017: Duplicate static output detection.
- [x] 018: App-owned `document.tsx` rendering.
- [x] 019: Runtime/server `ErrorBoundary` fallback behavior.
- [x] 020: Priority scheduler and cooperative transition yielding.
- [x] 021: Rich metadata for Open Graph, icons, canonical links, and alternates.
- [x] 022: Versioned compact render packet bridge.
- [x] 023: Server Suspense and render streams.
- [x] 024: Route `loading` and `error` conventions.
- [x] 025: Chunked dev HTTP for route loading streams.
- [x] 026: Dev streaming for inline Suspense routes.
- [x] 027: Native Rust render protocol crate.
- [x] 028: TypeScript protocol mirror validation.
- [x] 029: Rust-generated TypeScript protocol module.
- [x] 030: Directive-gated route hydration with `"use client"`.
- [x] 031: Server-route client reference manifest.
- [x] 032: Client reference browser chunks.
- [x] 033: Explicit client island hydration.
- [x] 034: Automatic client reference proxies for imported client components.
- [x] 035: Production stream HTTP adapter.
- [x] 036: Production cache-control and route metadata headers.
- [x] 037: Native Node SSR binding.
- [x] 038: Versioned client reference transport.
- [x] 039: Server payload stream packet.
- [x] 040: Server payload HTTP JSON/frame surfaces.
- [x] 041: Browser server payload application.
- [x] 042: Same-origin server payload navigation integration.
- [x] 043: Managed document head reconciliation during payload navigation.
- [x] 044: Payload-backed popstate restoration.
- [x] 045: Payload prefetching for navigation.
- [x] 046: Incremental browser payload streaming.
- [x] 047: HTTP server-payload stream frames.
- [x] 048: Navigator stream-mode selection.
- [x] 049: Production response compression.
- [x] 050: Immutable production asset fingerprints.
- [x] 051: Production asset preload hints.
- [x] 052: Production `Link` preload headers.
- [x] 053: Production request hardening.
- [x] 054: Production observer hooks and render timeouts.
- [x] 055: Production worker pool and shutdown drain hooks.
- [x] 056: Browser-safe `@ferrite/protocol` package.
- [x] 057: Native prebuild package resolution.
- [x] 058: Native prebuild checksum verification.
- [x] 059: Rust-backed WASM protocol validation package.
- [x] 060: Native prebuild dry-run workflow and verifier.
- [x] 061: npm package dry-run verifier and publish-prep metadata.
- [x] 062: First form-based server-action POST transport and example form.
- [x] 063: Staged npm tarball manifest verification.
- [x] 064: Clean npm tarball install smoke.
- [x] 065: Browser server-action form enhancement helper.
- [x] 066: Explicit server-action reference manifests in build/dev metadata.
- [x] 067: Idempotent generated client entrypoint server-action form bootstrap.
- [x] 068: Dedicated server-only route action bootstrap asset.
- [x] 069: Chromium proof for generated server-action form enhancement.
- [x] 070: Server-action `Origin`/`Referer` same-host rejection in dev and production adapters.
- [x] 071: Rust-backed WASM validation for server-payload stream frames.
- [x] 072: Browser bundler emits `@ferrite/protocol-wasm` WASM assets through the static public path.
- [x] 073: Chromium proof for server-payload prefetch navigation and stream-frame navigation.
- [x] 074: Chromium proof for stream-mode popstate payload restoration.
- [x] 075: Chromium proof for malformed server-payload rejection without DOM/history mutation.
- [x] 076: Chromium proof for malformed clicked-payload fallback to normal document navigation.
- [x] 077: Operator-facing deployment guide for the current production adapter.
- [x] 078: Production `ferrite serve` flags for request-read timeout, max request bytes, and in-flight request limits.
- [x] 079: Server-action POSTs require a valid `Host` before origin/referer checks.
- [x] 080: Opt-in hidden CSRF token rendering and server-action POST enforcement.
- [x] 081: Production CLI access logs for request observer events.
- [x] 082: Opt-in trusted-proxy public-origin validation for server-action POSTs.
- [x] 083: First-pass systemd, nginx, and container deployment templates.
- [x] 084: Explicit trusted-proxy client-IP access-log policy.
- [x] 085: Production server-action audit logs for action attempts and rejections.
- [x] 086: Production server-action CSRF double-submit cookie binding.
- [x] 087: Production in-memory Prometheus text metrics endpoint for request/action counters.
- [x] 088: Production server-action one-time replay nonces.
- [x] 089: Private-alpha GTM gate documentation and deterministic sequential browser gate.
- [x] 090: Dynamic action-route normalization, required example integration gate, bounded production admission, bundler deadlines, public error redaction, and safer deployment defaults.
- [x] 091: Versioned Cargo path dependencies, local workspace archive verification, honest package metadata, and a full-gate CI workflow definition.
- [x] 092: Staged versioned production artifacts with rollback, strict integrity loading and verified-byte retention, self-contained server modules, parameter-independent client bundles, artifact-only CLI serving, source/artifact-independent dynamic route/action proof, and removal of the global production request lock.
- [x] 093: Configurable absolute production response-write deadlines across fixed, gzip, chunked, parse-error, overload, and shutdown-drain paths, with real stalled-reader timeout proof.
- [x] 094: Native Darwin x64 prebuild CI moved from retired `macos-13` to the supported `macos-15-intel` runner label; local `actionlint` passes, while hosted execution remains unproven without a remote.
- [x] 095: Artifact-backed controlled saturation/recovery and runner-failure/next-request proof, plus overload socket half-close handling that preserves bounded `503` responses instead of resetting clients with unread request bytes.
- [x] 098: Bounded artifact-backed mixed-load soak with concurrent slow readers, deadline truncation, delayed-send overload `503` delivery, false-`408` rejection, post-saturation runner recovery, fixed rejection-worker and runner lifecycle cleanup, and final success.

## Vacuous Or Weak Test Audit

- [x] A simple empty-test scan did not find empty `test(..., () => {})` bodies.
- [x] A simple constant-assertion scan found only a few `assert.ok(...)` calls; the sampled uses check live stream controllers, payload lookups, or packet-size relationships.
- [x] Replaced the weak `scripts/verify-npm-packages.test.mjs` report-directory test with a real `verifyNpmPackages()` report test that exercises package validation, build and pack hooks, and `npm-package-report.json` output.
- [ ] `packages/node/test/binding-resolution.test.mjs` uses fake `require` and fake `readFileSync` helpers. These are acceptable unit tests for resolver branching, but they do not prove a package manager installed optional native packages correctly.
- [ ] `packages/node/test/prebuild-verifier.test.mjs` uses synthetic temp prebuild package directories. This is good verifier coverage, but it is not hosted-runner proof that each supported platform artifact can be built and aggregated.
- [x] `scripts/verify-npm-packages.test.mjs` now proves the verifier packs from staged release manifests, preserves source manifests, and rejects source-only fields in packed manifests.
- [x] The npm package verifier installs generated local tarballs in a temp project outside the workspace, smoke-imports protocol/runtime/WASM-safe packages, and uses a copied candidate CLI plus installed runtime runners for missing-artifact rejection, TypeScript check, production build, and artifact serve. Exact-pinned external build tools resolve from npm; unpublished Ferrite native prebuild loading remains unproven.
- [x] `packages/protocol-wasm/test/wasm.test.mjs` now proves Rust WASM validation for server-payload packets and stream frames; `test/browser-wasm-bundler.test.mjs` proves generated client bundles can import and emit the protocol WASM artifact through the configured public path.
- [ ] Runtime DOM coverage now includes Chromium proof for generated server-action form enhancement, payload prefetch/navigation, stream-frame navigation, stream-mode popstate restoration, malformed programmatic payload rejection, and malformed clicked-payload fallback, but hydration mismatch paths, failed or malformed popstate fallback behavior, and many focus/pointer/history edge cases still rely on deterministic `happy-dom` coverage.
- [x] `enhanceServerActionForms()` has focused red-to-green coverage for the normal enhanced submit path, invalid response failure path, plain-form fallback, and listener cleanup.
- [ ] Several proof docs rely on `--once`, temp fixtures, or local generated packages. These are valid milestone checks, but they are not deployment proof.
- [ ] Chromium action and payload tests use fixture HTTP servers with canned action responses or packets. They prove browser enhancement/navigation behavior, not browser-to-`ferrite serve` end-to-end behavior.
- [x] `pnpm test` now runs the real example build, render fixture, dev `--once`, and production serve `--once` path after the prior gate missed a dynamic server-action route-pattern regression.
- [x] A local instrumented `ferrite-dev-server` run reports 90.12% line, 90.20% function, and 89.58% region coverage across 90 tests.
- [ ] Commit workspace-wide Rust/JS branch coverage thresholds and mutation-testing policy; the one-time server measurement is not a CI gate.

No known tests were identified as deliberately fake success paths. The weak areas above should be treated as productionization backlog, not as evidence that the tested code is worthless.

## Fake, Simulated, Or Local-Only Proof Checklist

- [ ] GitHub state is local-only: no remote, no push, no PR, no remote CI run.
- [ ] Native prebuild workflow proof is local plus committed YAML; the hosted runner matrix has not run from this checkout.
- [ ] npm package proof now includes staged `npm pack --json` inspection plus clean candidate `check`/`build`/artifact-serve outside the workspace; no Ferrite package or CLI was published and no remote CI run consumed the artifacts.
- [x] Live staged-tarball inspection now proves packed manifests omit `private: true` and rewrite Ferrite `workspace:*` dependencies to `0.1.0` in `@ferrite/protocol-wasm` and `@ferrite/runtime`.
- [ ] `@ferrite/node` optional prebuild resolution is partly proven with faked package resolution and locally generated package directories, not a real registry install.
- [ ] Page-renderer server-action invocation and manifest tests use generated temp scripts/pages for subprocess proof. They exercise the protocol boundary and explicit rendered-form manifest collection, but not automatic `"use server"` discovery or a real deployment action registry.
- [ ] Browser runtime proof now includes Chromium coverage for generated server-action form enhancement, payload prefetch consumption, browser URL/title updates, stream-frame navigation, stream-mode popstate restoration, malformed programmatic payload rejection without DOM/history mutation, and malformed clicked-payload fallback to normal document navigation. Failed or malformed popstate fallback behavior, hydration mismatch paths, and many focus/pointer/history edge cases still mostly rely on Node plus `happy-dom`.
- [ ] Dev/serve proof now includes local sockets, one-shot example execution, source/dependency/artifact-removal integration, dynamic HTML/payload/conditional-action/asset checks, startup integrity rejection, and explicit overlapping runner intervals. It is still not a deployed production environment behind TLS, CDN, process manager, or container orchestration.
- [ ] Deployment templates have static verifier coverage for serve flags, proxy forwarded headers, trusted forwarded client-IP hop policy, non-root container runtime, and health-check presence. The exact artifact-only container also has local build/runtime proof for a dynamic route, fingerprinted asset, JSON access log, and no ambient package tree, but it has not run in hosted staging.
- [ ] Server actions are explicit form transport plus DOM form enhancement, explicit rendered-form manifests, generated client-entrypoint bootstrap, dedicated server-only action bootstrap assets, Chromium proof for enhanced route/island/server-only action forms, required action `Host`, same-host rejection for browser-supplied cross-origin `Origin`/`Referer` headers, opt-in trusted-proxy public-origin validation, explicit trusted forwarded client-IP log policy, opt-in hidden CSRF token enforcement, opt-in production double-submit CSRF cookie binding, opt-in single-process replay nonce enforcement, and production action observer/audit-log proof. There is still no automatic `"use server"` discovery, deployment-stable inferred action ID registry, session-bound CSRF token rotation, multi-process replay coordination, upload streaming, client event action surface, hosted staging proof, or external audit sink.

## Productionization Checklist

- [ ] Configure the GitHub remote, push the branch, open PRs, and record real PR URLs.
- [ ] Run remote CI for lint, test, build, typecheck, example build, npm package tarball/install verification, and native prebuild dry-run workflows.
- [x] Add explicit server-action manifests for rendered `createServerAction()` form references in build/dev metadata.
- [ ] Add automatic `"use server"` export discovery, deployment-stable inferred action IDs, and a persistent deployment action registry.
- [x] Add a browser-side progressive-enhancement helper for server-action form submissions and validated action responses.
- [x] Wire the server-action form enhancer into generated route/client-reference browser entrypoints where browser JavaScript already exists.
- [x] Emit a dedicated action-enhancer browser asset for server-only routes that contain server-action forms but no route/client-reference script.
- [ ] Add real browser tests for broader hydration behavior, payload navigation, streaming, popstate restoration, and prefetching. Payload prefetch/navigation, stream-frame navigation, valid stream-mode popstate restoration, malformed programmatic payload rejection, and malformed clicked-payload fallback now have Chromium proof; hydration mismatch paths, failed or malformed popstate fallback behavior, and broader focus/pointer/history edges still need browser coverage.
- [x] Add server-action browser header hardening: reject action POSTs when a present `Origin` or `Referer` host differs from the request `Host`.
- [x] Require a valid `Host` header for server-action POSTs before origin/referer comparison.
- [x] Add opt-in hidden CSRF token rendering and server-action POST enforcement.
- [x] Add opt-in trusted-proxy public-origin validation for server-action POSTs using `X-Forwarded-Proto` and `X-Forwarded-Host`.
- [x] Add opt-in production CSRF double-submit cookie binding for server-action POSTs.
- [x] Add opt-in single-process one-time replay nonce enforcement for production server-action POSTs.
- [ ] Add full server-action CSRF/session/replay hardening: token rotation, session binding, multi-process replay coordination, and clearer auth integration guidance.
- [x] Add explicit trusted-proxy client-IP access-log policy for forwarded client address headers.
- [x] Add production CLI access-log output for request observer events without headers or bodies.
- [x] Add first-pass production server-action audit logs for action attempts and rejections without headers, bodies, form fields, or CSRF tokens.
- [x] Add first-pass in-memory Prometheus text metrics for request/action observer outcomes.
- [x] Run Chromium browser test files sequentially in the repo browser gate to avoid cross-file browser-session races while preserving real browser coverage.
- [ ] Add first-class tracing sinks and richer external audit exporters for request/action observer events.
- [x] Expose production request-read timeout, request-byte, and in-flight request limits through the `ferrite serve` CLI.
- [x] Make the in-flight limit count queued and active sockets and reject excess connections with `503` instead of using an unbounded work queue.
- [x] Apply the production subprocess deadline to client bundling as well as rendering, and keep raw subprocess errors out of public production HTML.
- [x] Make the supplied nginx edge overwrite `X-Forwarded-For`, block public metrics proxying, and exclude common env/key files from the container build context.
- [x] Make `ferrite build` stage and install the versioned server artifact consumed by `ferrite serve`, with self-contained modules, route-level client bundles, build-observed action metadata, file integrity records, and rollback on activation failure.
- [ ] Add a versioned release-directory or image-pointer activation path for a truly atomic production rollout; direct replacement of an existing directory has a brief activation window.
- [x] Remove the shared `ProductionProject` mutex from matched route handling and prove two deliberately slow artifact requests overlap.
- [x] Add artifact-backed controlled saturation, recovered-capacity, and failed-runner/next-request regression proof.
- [x] Run bounded sustained mixed-load and concurrent slow-reader regression proof across real sockets.
- [ ] Run hosted and long-duration capacity benchmarks with explicit throughput and latency targets.
- [x] Add a configurable absolute response-write timeout and real stalled-reader coverage.
- [ ] Run the native prebuild workflow on supported hosted runners and verify aggregate artifacts from CI.
- [ ] Add real npm publishing workflow with provenance, trusted publishing or `NPM_TOKEN`, and native prebuild publication ordering.
- [x] Add a local Cargo workspace package gate with versioned internal path dependencies; all 11 crate archives now build with `--no-verify`.
- [ ] Prove Cargo publish ordering and installation from a registry; local archive creation is not registry proof.
- [ ] Decide code-signing/notarization policy for native artifacts.
- [x] Add deployment documentation for production serve topology, TLS/proxy expectations, runtime configuration, rollback, and observability.
- [x] Add first-pass systemd, nginx, and container deployment templates for the documented private-beta topology.
- [ ] Prove one deployment template in a hosted staging environment and record health checks, smoke tests, access logs, rollback, and proxy header behavior.
- [ ] Add Helm or managed-platform deployment templates once a target platform is chosen.
- [x] Make the npm verifier pack release-shaped staging manifests and reject `private: true` and `workspace:*` in actual tarball manifests.
- [x] Add package-install smoke tests that consume packed packages from a clean project.
- [x] Add fail-closed `ferrite init` generation and make the clean candidate verifier consume the generated starter for TypeScript check, production build, and artifact serve.
- [x] Add browser bundler integration for the WASM protocol package where appropriate.
- [x] Add stronger protocol-WASM proof for streaming payload validation, not only basic server-payload JSON validation.
- [ ] Add upload streaming or file-part support if server actions need file inputs; current behavior rejects file parts.
- [ ] Add client event actions only after the form-action registry and security model are stable.
- [ ] Define the long-term RSC/Flight compatibility strategy; current payload protocol is Ferrite-owned and not Flight-compatible.
- [ ] Define whether Fiber-style resumable rendering is required; current renderer is not a resumable Fiber implementation.

## Documentation Sync Notes

- [x] Current README and architecture docs now call out the implemented form enhancer, explicit server-action manifests, generated client-entrypoint bootstrap, server-only-route enhancer assets, Chromium action-form proof, and the missing automatic action discovery plus deployment-stable inferred IDs.
- [x] Historical superpowers implementation plans now mark completed local work as checked where proof docs and commits show completion.
- [x] Remote-dependent push/PR steps remain unclaimed because this checkout has no remote.
- [x] The audit now distinguishes staged tarball manifest and clean-install proof from remaining remote-CI and publication proof.
- [x] Deployment docs now describe the current production adapter path, proxy/TLS assumptions, smoke tests, rollback, observability hooks, and security gaps without claiming deployed proof.
- [x] README, architecture, deployment, GTM, readiness, and status docs now distinguish source-driven development/build execution from artifact-only production execution and preserve remote/hosted/load gaps.
- [x] `ferrite serve` now exposes the main production request and render limits documented in the deployment guide.
- [x] Deployment docs now document `--server-action-csrf-token-env` as the opt-in server-action CSRF token path while preserving remaining session/replay/auth gaps.
- [x] Deployment docs now document `--server-action-csrf-cookie-name` as the opt-in production double-submit cookie binding path while preserving remaining session/replay/auth gaps.
- [x] Deployment docs now document `--server-action-replay-ttl-ms` as the opt-in production replay nonce path while preserving remaining session/multi-process/auth gaps.
- [x] Deployment docs now document `--access-log plain|json` as the CLI request outcome logging path while preserving remaining metrics/tracing gaps.
- [x] Deployment docs now document `--action-log plain|json` as the CLI server-action audit-log path while preserving remaining external sink and hosted-staging gaps.
- [x] Deployment docs now document `--metrics-path` as the first-pass in-memory Prometheus text metrics endpoint while preserving remaining tracing/external-sink gaps.
- [x] Deployment docs now document `--trusted-proxy-public-origin` as the opt-in server-action trusted-proxy origin path while preserving remaining session/replay/auth gaps.
- [x] Deployment docs now document `--trusted-proxy-client-ip-hops` as the explicit forwarded client-IP access-log trust policy while preserving remaining session/replay/auth gaps.
- [x] Deployment docs now point to first-pass systemd, nginx, container, and env templates while preserving the missing hosted-staging proof gap.
- [x] GTM/deployment docs now state a private-alpha-only market path with explicit disallowed claims and required remote CI, hosted staging, artifact, smoke, observability, and rollback evidence.
- [ ] Historical proof docs are not rewritten to erase their original "Not Proven Yet" context; they should be read as milestone snapshots.
