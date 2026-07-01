# Milestone 008 Proof

Date: 2026-06-29

## What Changed

- Added `collectStaticParams()` to `@ferrite/runtime/server`.
- Added `--static-params` mode to `packages/runtime/bin/render-page.mjs`.
- Added `PageRenderer::generate_static_params()` in Rust.
- Changed `ferrite build` to call `generateStaticParams` for dynamic routes and expand normal dynamic params into concrete output paths.
- Changed generated dynamic build output to render page HTML with the generated params and emit route-specific client bundles.
- Added validation that rejects missing, unknown, empty, multi-segment, and parent-directory static param values before writing files.
- Updated the example post route to export `generateStaticParams()` for `alpha` and `beta`.

## Why

Static production builds need a way to turn dynamic route patterns into concrete HTML files. The generator runs in the JS/TS page-module bridge, while Rust owns route expansion, filesystem output, manifest state, bundle orchestration, and unsafe path rejection.

## Verified

```sh
cargo fmt --all -- --check
cargo test -p ferrite-page-renderer -p ferrite-builder
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs --static-params 'examples/basic/app/posts/[id]/page.tsx'
pnpm build:example
```

Observed proof:

- Direct static-param collection returned `{"has_generate_static_params":true,"params":[{"id":"alpha"},{"id":"beta"}]}`.
- `ferrite build --project examples/basic` reported `html files: 3`, `client bundles: 3`, and `skipped dynamic routes: 0`.
- The build wrote `posts/alpha/index.html` and `posts/beta/index.html`.
- `posts/alpha/index.html` contains `data-route="/posts/alpha"` and `<h1>Post alpha</h1>`.
- The build manifest records `route-posts-alpha.js` and `route-posts-beta.js` client bundles.

The Rust tests prove:

- Static-param JSON output is parsed by the page renderer.
- Static-param runner failures are reported.
- Dynamic routes without `generateStaticParams` remain skipped.
- Dynamic routes with generated params produce concrete HTML files and client bundles.
- Unsafe generated params such as `../secret` fail before output path creation.
- Existing static route builds, client bundle failures, render failures, route metadata escaping, and missing app-dir errors still behave correctly.

## Not Proven Yet

- Catch-all and optional catch-all static params are rejected for now because the route param model still needs array-valued params across dev, build, render, and bundle paths.
- Duplicate generated params are not deduplicated yet.
- Generated static params are not cached between build steps.
- Layout and metadata composition are not implemented.
- Browser updates still use full rerendering rather than keyed reconciliation.
