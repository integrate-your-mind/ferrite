# Milestone 019 Proof

Date: 2026-06-29

## What Changed

- Added a callable `ErrorBoundary` primitive to `@ferrite/runtime` so app authors can use it as normal TSX.
- Added `ErrorBoundaryFallbackProps`, `ErrorBoundaryFallback`, and `ErrorBoundaryProps` to the public runtime types.
- Taught DOM rendering and hydration to catch child render failures at the nearest `ErrorBoundary`.
- Added persistent boundary error state plus a `reset()` fallback callback for interactive retry.
- Routed transition-triggered render failures through the same boundary path.
- Taught server serialization to emit boundary fallback output when a child render fails.
- Added `examples/basic/app/error-demo/page.tsx` as a real route proving SSR recovery through dev and production build paths.
- Updated README and architecture docs so the current boundaries and next milestone queue match the implementation.

## Why

Ferrite already had microtask-based transition scheduling, dev/build TSX execution, and app-owned documents, but render errors still escaped to generic failures. A framework needs a local recovery primitive before transition and route work can become more realistic. This milestone keeps the API small: boundaries catch render-time child failures, expose a typed fallback, and let the fallback reset the boundary.

## Verified

```sh
cargo fmt --all
pnpm --filter @ferrite/runtime test
pnpm typecheck
pnpm build:example
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /error-demo
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Observed proof:

- Runtime tests passed: 45 tests.
- New runtime tests cover normal caught render fallback, reset retry, transition-caused render failure routing, SSR fallback serialization, hydration fallback attachment, and missing fallback validation.
- Full Rust workspace tests passed: builder 17, CLI 2, client bundler 4, core 6, dev server 15, page renderer 11, router 5, SSR 3.
- `pnpm lint` passed: `cargo fmt --all -- --check`, clippy with `-D warnings`, and runtime typecheck.
- `pnpm build` passed for the Rust workspace and runtime package.
- `pnpm typecheck` passed and the example CLI check reported 4 routes.
- Production example build wrote 4 routes, 6 HTML files, 6 client bundles, and 0 skipped dynamic routes.
- Production `/error-demo` HTML includes `<title>Ferrite Error Demo</title>`, `data-error-boundary="recovered"`, and `Recovered: Demo failure recovered by ErrorBoundary`.
- Dev one-shot `/error-demo` emitted the same recovered fallback inside the custom `app/document.tsx` shell with `id="ferrite-dev-root"`.
- Existing `/posts/abc` dev one-shot and fixture render still passed after adding the boundary route.

## Not Proven Yet

- Error boundaries catch render-time failures only; event handler, async callback, and effect cleanup errors are not boundary-routed.
- Ferrite still does not implement React class lifecycle error boundaries.
- Transition scheduling is still microtask-based; priority scheduling and interruptible rendering remain future work.
- There is no coverage-reporting tool configured, so coverage was checked by targeted tests and full gates rather than a numeric coverage report.
