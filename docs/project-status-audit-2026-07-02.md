# Project Status Audit: 2026-07-02

This audit records the current local state of the Ferrite framework on branch
`codex/protocol-wasm-validation`.

Evidence used:

- `git log --oneline --reverse --all --decorate`
- `git status --short --branch`
- `git remote -v`
- `README.md`
- `docs/architecture.md`
- `docs/milestone-001-proof.md` through `docs/milestone-062-proof.md`
- `package.json`
- representative tests under `packages/`, `scripts/`, and `crates/`

## Current External State

- [x] Local branch exists: `codex/protocol-wasm-validation`.
- [x] Local milestone proof docs exist through milestone 062.
- [x] Working tree docs were refreshed by a documentation subagent and reviewed locally.
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

## Vacuous Or Weak Test Audit

- [x] A simple empty-test scan did not find empty `test(..., () => {})` bodies.
- [x] A simple constant-assertion scan found only a few `assert.ok(...)` calls; the sampled uses check live stream controllers, payload lookups, or packet-size relationships.
- [x] Replaced the weak `scripts/verify-npm-packages.test.mjs` report-directory test with a real `verifyNpmPackages()` report test that exercises package validation, build and pack hooks, and `npm-package-report.json` output.
- [ ] `packages/node/test/binding-resolution.test.mjs` uses fake `require` and fake `readFileSync` helpers. These are acceptable unit tests for resolver branching, but they do not prove a package manager installed optional native packages correctly.
- [ ] Runtime DOM coverage uses `happy-dom`. It is useful for deterministic unit and integration behavior, but it is not a real browser-engine proof for hydration, navigation, form submission, focus, pointer, or history behavior.
- [ ] Several proof docs rely on `--once`, temp fixtures, or local generated packages. These are valid milestone checks, but they are not deployment proof.

No known tests were identified as deliberately fake success paths. The weak areas above should be treated as productionization backlog, not as evidence that the tested code is worthless.

## Fake, Simulated, Or Local-Only Proof Checklist

- [ ] GitHub state is local-only: no remote, no push, no PR, no remote CI run.
- [ ] Native prebuild workflow proof is local plus committed YAML; the hosted runner matrix has not run from this checkout.
- [ ] npm package proof is `npm pack --dry-run --json`; no package was published.
- [ ] `@ferrite/node` optional prebuild resolution is partly proven with faked package resolution and locally generated package directories, not a real registry install.
- [ ] Browser runtime proof uses Node plus `happy-dom`, not Playwright/WebDriver in Chromium/WebKit/Firefox.
- [ ] Dev/serve proof is local socket and one-shot proof, not a deployed production environment behind TLS, CDN, process manager, or container orchestration.
- [ ] Server actions are form transport only. There is no deployment-stable action manifest, no automatic `"use server"` discovery, and no client progressive-enhancement helper yet.

## Productionization Checklist

- [ ] Configure the GitHub remote, push the branch, open PRs, and record real PR URLs.
- [ ] Run remote CI for lint, test, build, typecheck, example build, npm package dry-run, and native prebuild dry-run workflows.
- [ ] Add static server-action manifests, automatic `"use server"` export discovery, and deployment-stable action IDs.
- [ ] Add a browser-side progressive-enhancement helper for server-action form submissions and validated action responses.
- [ ] Add real browser tests for hydration, payload navigation, streaming, popstate restoration, prefetching, and server-action form submission.
- [ ] Add server-action security hardening: origin/CSRF policy, cookie/session integration points, replay considerations, and clearer auth guidance.
- [ ] Add first-class production logging/tracing sinks for request observer events.
- [ ] Run the native prebuild workflow on supported hosted runners and verify aggregate artifacts from CI.
- [ ] Add real npm publishing workflow with provenance, trusted publishing or `NPM_TOKEN`, and native prebuild publication ordering.
- [ ] Decide code-signing/notarization policy for native artifacts.
- [ ] Add deployment documentation for production serve topology, TLS/proxy expectations, process supervision, environment variables, rollback, and observability.
- [ ] Add package-install smoke tests that consume packed packages from a clean project.
- [ ] Add browser bundler integration for the WASM protocol package where appropriate.
- [ ] Add upload streaming or file-part support if server actions need file inputs; current behavior rejects file parts.
- [ ] Add client event actions only after the form-action registry and security model are stable.
- [ ] Define the long-term RSC/Flight compatibility strategy; current payload protocol is Ferrite-owned and not Flight-compatible.
- [ ] Define whether Fiber-style resumable rendering is required; current renderer is not a resumable Fiber implementation.

## Documentation Sync Notes

- [x] Current README and architecture docs now call out the missing static action manifest and client progressive-enhancement helper.
- [x] Historical superpowers implementation plans now mark completed local work as checked where proof docs and commits show completion.
- [x] Remote-dependent push/PR steps remain unclaimed because this checkout has no remote.
- [ ] Historical proof docs are not rewritten to erase their original "Not Proven Yet" context; they should be read as milestone snapshots.
