# Ferrite Go-to-Market Plan (Private Beta Readiness)

**Updated:** July 29, 2026
**Current project state:** The GitHub repository and PR path now exist, and the local checkout has an artifact-backed, source-independent build/serve path with fail-closed integrity, strict HTTP request-framing, a 43-case nginx HTTP/1 TLS verifier plus seven negotiated HTTP/2 edge cases, concurrent execution, and bounded sustained-load proof. Clean proxy evidence is built from an immutable exact Git archive and requires five ambiguous framing probes plus nine raw-target probes to show no upstream status; dirty-worktree runs are development evidence only. GitHub Actions is no longer the active CI path. A dedicated local Buildkite-agent lane is defined, but exact-pushed-SHA Buildkite execution and hosted deployment have not been proven. This plan assumes a narrow private beta only after explicit delivery gates are met.

## Positioning

Ferrite is a Rust-first React-style app framework with a Next-style app directory, TypeScript-first DX, and a Rust-owned rendering/build/runtime control plane. The differentiator is performance predictability and deployment control from a native core while keeping a familiar TS/TSX surface for existing teams.

Position statement:
- Ferrite is for teams that want a modern app-shell + SSR + streaming stack with tighter control over render/runtime and dependency shape than Node-first "framework-as-bundle" stacks.
- It is most compelling for early adopters who are already comfortable with React-like patterns and are optimizing for build determinism, runtime boundaries, and protocol-level validation.

Messaging should avoid overpromising. Current proof is real for local and browser-integration paths, but this is **not yet production-ready for unmanaged public use**.

## ICP

Primary ICP: 8–30 person engineering teams shipping internal dashboards, docs portals, and content-heavy web products with React-like architecture.

- They already use TypeScript and route-based page architecture.
- They care about predictable render behavior, clear SSR contract boundaries, and stable asset pipelines.
- They can absorb explicit setup steps and feedback loops in a private beta.
- They are okay with a framework that is intentionally opinionated and "first-party integration-light."

Secondary ICP:
- Infra-forward teams evaluating alternatives to mature Next.js setups for embedded/edge workloads.
- Tooling teams shipping in regulated environments who want server-action and payload validation explicitness before enabling broader auth flows.

## Current Sellable Demo

Current demoable scope is the local `examples/basic` end-to-end path:

- Route discovery and validation (`ferrite check`), type generation, and route typing (`.ferrite/types/routes.d.ts`).
- Build and serve pipeline (`ferrite build`, `ferrite serve`) including static prerendering, route-level payload output, and generated client assets.
- Next-style app patterns: `app/layout.tsx`, `app/document.tsx`, `layout` wrappers, metadata (`metadata` + `generateMetadata`), `loading.tsx`, `error.tsx`, and dynamic/static-catch-all routing through `generateStaticParams`.
- Streaming and payload behavior: stream-capable dev/serve paths, server payload JSON/stream-frame surfaces, same-origin payload navigation, prefetch and popstate restoration support with Chromium proof.
- Island hydration: server-first routes, `use client` islands, route and client-reference bundles, and immutable fingerprinted assets.
- Server-action first transport: form-based `POST /_ferrite/action` with explicit action manifest collection and browser enhancement for route/client-reference/server-only action forms (Chromium proof).
- Production logs: request outcome access logs and first-pass server-action audit logs can be emitted to stderr in plain or JSON format.
- Production HTTP boundary: exact HTTP/1.1 origin-form requests, fail-closed framing and authority validation, one request per closed connection, and an authority-rejecting buffering nginx template with a self-contained, exact-source raw-TLS matrix.

Not sellable yet as a hosted platform:
- No npm publish in this checkout, no exact-pushed-SHA Buildkite job, no hosted staging run of the deployment templates, and only local/prototype operational proof. A trusted local Buildkite run would still not establish independent hosted-runner or cross-platform evidence.
- Server-action security remains incomplete for real mutable user flows.

## Fastest Path To Market

The fastest credible market motion is not a public launch. It is a tightly scoped
self-hosted private alpha for one or two trusted engineering teams building
internal dashboards, docs portals, or content-heavy apps.

Allowed alpha claims:
- Rust-first app framework with a familiar TypeScript/TSX facade.
- Local and browser-tested route analysis, build, serve, SSR, payload navigation, streaming, and explicit form-action flows.
- First-pass self-hosted deployment templates with clear proxy/TLS/process assumptions.
- Local package verification and release-shaped tarball proof.

Disallowed alpha claims until proven:
- Public production readiness.
- Hosted platform readiness.
- Auth-complete or mutation-safe server actions.
- Published npm/native package availability.
- React Flight/RSC parity or full browser-matrix support.
- Production observability beyond stderr logs and in-memory metrics.

### ASAP Alpha Launch Gate

1. Keep launch work on focused GitHub PRs and bind each Buildkite run and local proof receipt to the exact candidate SHA.
2. Run the full release gate on the exact commit offered to alpha users: lint, typecheck, build, unit tests, browser tests, artifact-backed example integration, npm and Cargo package verification, coverage, native prebuild dry-run, and nginx proof. A maintainer-controlled local Buildkite agent is CI evidence, not independent hosted-runner or cross-platform proof.
3. Prove the artifact-backed container or systemd template in hosted staging behind a real proxy/TLS boundary, including startup integrity rejection, dynamic route/payload/action smoke, private metrics scrape, logs, overload rejection, restart, and rollback.
4. Define throughput and latency targets and run hosted capacity tests; bounded mixed-load, concurrent slow-reader, controlled saturation, and artifact-runner recovery are now local regression gates, not capacity benchmarks.
5. Publish a private-alpha onboarding page that states allowed use, disallowed use, install prerequisites, release artifact source, support channel, and no-SLA terms.
6. Decide the alpha distribution path: private npm scope, tarball bundle, or source checkout. Do not charge for reliability until a real npm/native publish path is proven.
7. Keep server actions limited to controlled/internal flows unless app-owned auth and CSRF middleware have been reviewed separately.

## Blockers To Paid Beta

1. Production runtime architecture
- `ferrite build` now stages and installs a versioned, SHA-256-verified server artifact; `ferrite serve` retains verified bytes before startup and uses a production runner without esbuild or source access. A versioned release directory/image pointer is still required for atomic rollout.
- Immutable route state is shared without a project-wide mutex; local artifact-backed regressions prove overlapping requests, bounded mixed-load waves, prompt `503`s during slow-reader saturation, recovered capacity, and successful worker reuse after a runner subprocess failure. Hosted capacity, host-process supervisor recovery, and multi-instance behavior remain unproven.
- Production sockets have a configurable absolute response-write deadline with fixed, gzip, chunked, parse-error, overload, shutdown-drain, concurrent slow-reader, and post-saturation regression coverage. Hosted throughput and capacity remain unproven.

2. Remote delivery proof gaps
- GitHub remote, push, PR, review, and merge proof exist. Buildkite is the active CI path, but the dedicated maintainer-controlled local agent does not establish independent hosted-runner or cross-platform execution.
- `release:verify:npm` requires an exact-source passed Buildkite build and byte-verified package artifacts; the current candidate still needs that terminal proof.

3. npm publishing and native package distribution
- No real `npm publish` has been performed.
- Native prebuild publication ordering and registry visibility are not proven.
- Current clean-install smoke omits optional native package installation by design.
- Cargo archives now package locally with versioned internal dependencies, but publish ordering and registry installation remain unproven.

4. Hosted deployment posture
- Deployment docs and first-pass systemd/nginx/container templates exist, but there is no official published container image, Helm chart, managed-platform adapter, or hosted staging proof.
- No public production topology benchmarked on hosted infra.

5. Server-action security gaps
- Explicit form transport only, not automatic `"use server"` discovery.
- CSRF is opt-in and static-token based with optional SameSite/HttpOnly/Secure double-submit cookie binding. Single-process one-time replay nonces can be bound to an app-owned session-cookie fingerprint and exact route, but there is still no session-bound CSRF token issuance/rotation, multi-process replay coordination, or first-class auth middleware integration.
- Trusted-proxy public-origin checks and explicit forwarded client-IP access-log policy now exist. The pinned-nginx candidate-image harness proves the local topology; hosted ingress/CDN topology is not finalized.
- File uploads (`multipart` file parts) are intentionally rejected.

6. Observability + operations depth
- Request observer and action observer hooks exist in Rust, and the CLI can emit plain or JSON request outcome access logs plus server-action audit logs to stderr.
- The CLI can expose in-memory Prometheus-style request/action counters with `--metrics-path`, but there are still no tracing exporters or external audit sinks.
- Some browser edge cases remain in happy-dom coverage rather than full cross-browser proof.

## 2-Week Private Beta Plan

**Objective:** Reach a defensible private beta that is explicitly limited to trusted teams and explicit risks.

### Week 1
- Day 1–2: finish the current exact-head candidate-image/nginx proof packet, obtain distinct review, and run every required Buildkite job without bypassing checks.
- Day 3–4: define service-level targets and run hosted capacity and long-duration tests around the completed response-write, mixed-load, controlled-overload, and artifact-runner recovery regressions.
- Day 5: complete hosted deployment hardening pass 1:
  - run `ferrite serve` smoke and payload-action smoke behind a known reverse proxy,
  - publish restart/rollback runbook, CLI request/action log schemas, and metrics/tracing integration plan.
- Day 6–7: security backlog pass:
  - session-bound CSRF token issuance beyond the current global double-submit token and app-session replay binding,
  - explicit replay and token rotation plan,
  - trusted-proxy deployment test matrix, including forwarded proto/host and forwarded client-IP policy.

### Week 2
- Day 8: harden CI proof by running the full gate set through Buildkite (release lint/test/build, example integration, pinned-nginx candidate-image proof, npm/Cargo package verification, coverage, native prebuild dry-run, browser proof), then separately exercise supported cross-platform or hosted staging paths.
- Day 9–10: close server-action reliability and UX:
  - exercise server-action production failure-path audit logs in hosted staging and decide the external sink contract,
  - validate rejection/mismatch flows in real browser automation and one negative-path test per route/action class.
- Day 11–12: npm publishing readies:
  - decide trusted publishing or `NPM_TOKEN`,
  - validate remote publish dry-run or staging registry publish simulation.
- Day 13–14: private beta gate review and launch-readiness checklist:
  - sign-off on "allowed beta uses",
  - publish private docs and support boundaries,
  - begin paid pilot onboarding with one to two design-partner projects.

## Pricing Hypotheses

- **Entry private beta (free with support cap):**
  1 paid seat for evaluation use, up to 2 production-like domains, no guarantees, on-call support excluded.
  Goal: reduce barrier to first pilots and collect hard usage data.

- **Early adopters (pilot):**
  $250–$750/month per org for 5–15k monthly active sessions. Includes private Slack support and migration office hours.

- **Growth tier:**
  $1,500+/month per org for teams requiring SSR/streaming guarantees, private support, and release windows.

These are hypotheses to validate via 4–8 design-partner conversions and churn-to-upgrade behavior after 30 days.

## Risk Register

- **R1: Remote proof never completed in time**
  Impact: cannot trust build quality.
  Mitigation: make exact-SHA Buildkite proof a hard release gate, retain its local-agent trust boundary, and include artifact links in weekly review.

- **R2: Server-action security incident before auth hardening**
  Impact: trust loss and legal exposure in authenticated workloads.
  Mitigation: keep private beta scope to unauthenticated/internal workflows until authenticated session validation, session-bound CSRF issuance, replay behavior in the chosen topology, and proxy trust are proven.

- **R3: Hosting mismatch/performance regressions in production topologies**
  Impact: deployment failure and unreliable latency claims.
  Mitigation: ship only documented topology defaults (`TLS+proxy+private bind`, bounded limits, conservative cache headers), and publish explicit unsupported cases.

- **R4: Missing npm and native publishing confidence**
  Impact: install/runtime path uncertainty for adopters.
  Mitigation: complete trusted publish path and published checksum/version traceability before charging for reliability commitments.

- **R5: Overlapping proof interpretation (local proof mistaken as production proof)**
  Impact: overselling, churn, support load.
  Mitigation: gate all external statements with "local proof" vs "remote/hosted proof" tags in sales and docs.

## Proof Required Before Launch

Launch here means paid beta availability to external teams under explicit usage limits.

- GitHub and Buildkite proof:
  - Exact-source Buildkite CI with lint/typecheck/test/build, `release:verify:npm`, coverage, native prebuild workflow, nginx, and browser proof.
  - CI runs on the same commit used for beta release, while independent hosted and cross-platform proof remains a separate claim.
- Publishing proof:
  - Proven npm publish workflow with provenance/trusted publishing or `NPM_TOKEN`.
  - Release artifacts for `@ferrite/*` visible and reproducible; prebuild packages emitted and verified.
- Deployment proof:
  - One documented and reproducible deployment stack (proxy + process manager or container + health/smoke checks) run in staging.
  - Rollback drill captured with artifact/version lock record.
- Server-action security proof:
  - Authenticated session and session-bound CSRF token strategy implemented (or explicit reviewed alternate beyond the static double-submit token and process-local replay binding) and tested for rotation plus replay in the chosen process topology.
  - Trusted-proxy public-origin checks and forwarded client-IP access-log policy exercised behind the chosen staging proxy with forwarded-header sanitization.
- Operational proof:
  - CLI request access-log and server-action audit-log output captured in staging and integrated with the chosen log collector.
  - Metrics scrape captured from `--metrics-path`, plus a decided tracing path for request observer events and action observer outcomes.
  - Negative-path coverage for malformed routes, action failures, malformed payloads, and origin/referer mismatches in automated CI.
- Product-readiness proof:
  - Explicitly separate "validated features" from "local-only proof" in public docs and sales copy.
  - No claim of React Flight/RSC parity, no claim of full browser matrix until verified, no claim of production-ready server actions until auth security path is complete.
