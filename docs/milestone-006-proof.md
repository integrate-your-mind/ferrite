# Milestone 006 Proof

Date: 2026-06-29

## What Changed

- Added `@ferrite/runtime/server` with `renderPageModule()`.
- Added `packages/runtime/bin/render-page.mjs`, a Node runner that uses esbuild to compile TSX page modules.
- Added `ferrite-page-renderer`, a Rust crate that calls the page runner, captures serialized Ferrite VNodes, and renders them to HTML through Rust SSR.
- Changed `ferrite dev` matched routes from route shells to executed TSX page output.
- Changed `ferrite build` static routes from route shells to executed TSX page output.
- Added `--page-renderer` to `ferrite dev` and `ferrite build` for scriptable override/testing.
- Updated the example pages so proof output is visibly page-derived.

## Why

The framework needs to run user-authored TypeScript/TSX components. This milestone keeps Rust in charge of routing, build/dev orchestration, and final SSR rendering, while using a narrow JS bridge to compile and execute TSX page modules.

## Verified

```sh
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs examples/basic/app/page.tsx '{"params":{}}'
node packages/runtime/bin/render-page.mjs 'examples/basic/app/posts/[id]/page.tsx' '{"params":{"id":"abc"}}'
pnpm dev:once
pnpm build:example
```

Observed proof:

- The direct page runner rendered `Ferrite Home` from `examples/basic/app/page.tsx`.
- The direct page runner rendered `Post abc` from `examples/basic/app/posts/[id]/page.tsx`.
- `ferrite dev --once --request-path /posts/abc` returned HTML containing `<article data-route="/posts/:id"><h1>Post abc</h1></article>`.
- `ferrite build --project examples/basic` wrote `index.html` containing `<h1>Ferrite Home</h1>` and `Count: 0`.

The Rust tests prove:

- The Rust page renderer converts runner JSON into Rust-rendered HTML.
- Runner failures are reported instead of silently falling back.
- Builder fails when page execution fails.
- Dev server returns 500 for page render failures.
- Dev server and builder still preserve route matching, manifests, type generation, and dynamic route skip behavior.

## Not Proven Yet

- Browser module bundling for client-side code.
- Source maps.
- CSS and asset handling.
- Static parameter generation for dynamic routes.
- Layout composition.
- Server/client component boundaries.
- Native NAPI/WASM page execution bridge.

