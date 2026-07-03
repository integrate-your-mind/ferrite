# Ferrite Go-to-Market Plan (Private Beta Readiness)

**Context date:** July 3, 2026
**Current project state:** Local checkout has strong engineering proof, but limited live-deployment proof. This plan assumes a narrow private beta only after explicit delivery gates are met.

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

Not sellable yet as a hosted platform:
- No npm publish in this checkout, no remote CI runs, no production deployment templates (proxy/platform process manager/container), and only local/prototype operational proof.
- Server-action security remains incomplete for real mutable user flows.

## Blockers To Paid Beta

1. Remote delivery proof gaps
- No GitHub remote, no push/PR, no remote CI for lint/build/test/package-verifier/prebuild workflows.
- `release:verify:npm` exists locally but is not exercised in this repo’s real CI.

2. npm publishing and native package distribution
- No real `npm publish` has been performed.
- Native prebuild publication ordering and registry visibility are not proven.
- Current clean-install smoke omits optional native package installation by design.

3. Hosted deployment posture
- Deployment docs exist and cover reverse-proxy expectations, but there is no official container, process manager, Helm, or managed-platform adapter.
- No public production topology benchmarked on hosted infra.

4. Server-action security gaps
- Explicit form transport only, not automatic `"use server"` discovery.
- CSRF is opt-in and static-token based; no session-bound token rotation/replay defense, cookie guidance, or first-class auth middleware integration.
- Trusted-proxy public-origin checks now exist for action POSTs, but forwarded client-IP trust policy and production topology proof are not finalized.
- File uploads (`multipart` file parts) are intentionally rejected.

5. Observability + operations depth
- Request observer hooks exist in Rust, and the CLI can emit plain or JSON request outcome access logs.
- There are still no first-class metrics/tracing exporters or richer action-specific audit sinks.
- Some browser edge cases remain in happy-dom coverage rather than full cross-browser proof.

## 2-Week Private Beta Plan

**Objective:** Reach a defensible private beta that is explicitly limited to trusted teams and explicit risks.

### Week 1
- Day 1–2: finalize positioning, onboarding, and beta access policy; publish explicit "private beta terms" (no production SLA).
- Day 3–4: harden CI proof by integrating and running full local gate set in remote CI (release lint/test/build, `release:verify:npm`, native prebuild dry-run, browser proof).
- Day 5: complete deployment hardening pass 1:
  - run `ferrite serve` smoke and payload-action smoke behind a known reverse proxy,
  - publish restart/rollback runbook, CLI access-log schema, and metrics/tracing integration plan.
- Day 6–7: security backlog pass:
  - session-bound token or equivalent CSRF design,
  - explicit replay and token rotation plan,
  - trusted-proxy deployment test matrix, including forwarded proto/host and client-IP policy.

### Week 2
- Day 8–10: close server-action reliability and UX:
  - add server-action production failure-path telemetry,
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
  Mitigation: make remote CI proof a hard release gate and include artifact links in weekly review.

- **R2: Server-action security incident before auth hardening**
  Impact: trust loss and legal exposure in authenticated workloads.
  Mitigation: keep private beta scope to unauthenticated/internal workflows until session-bound CSRF/replay and proxy trust are proven.

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

- Remote GitHub proof:
  - Remote CI with lint/typecheck/test/build, `release:verify:npm`, native prebuild workflow, browser proof.
  - CI runs on same commit used for beta release.
- Publishing proof:
  - Proven npm publish workflow with provenance/trusted publishing or `NPM_TOKEN`.
  - Release artifacts for `@ferrite/*` visible and reproducible; prebuild packages emitted and verified.
- Deployment proof:
  - One documented and reproducible deployment stack (proxy + process manager + health/smoke checks) run in staging.
  - Rollback drill captured with artifact/version lock record.
- Server-action security proof:
  - Session-bound CSRF token strategy implemented (or explicit alternate) and tested for rotation/replay.
  - Trusted-proxy public-origin checks exercised behind the chosen staging proxy with forwarded-header sanitization.
- Operational proof:
  - CLI access-log output captured in staging and integrated with the chosen log collector.
  - Metrics/tracing path for request observer events and action endpoint outcomes.
  - Negative-path coverage for malformed routes, action failures, malformed payloads, and origin/referer mismatches in automated CI.
- Product-readiness proof:
  - Explicitly separate "validated features" from "local-only proof" in public docs and sales copy.
  - No claim of React Flight/RSC parity, no claim of full browser matrix until verified, no claim of production-ready server actions until auth security path is complete.
