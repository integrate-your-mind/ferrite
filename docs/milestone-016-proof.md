# Milestone 016 Proof

Date: 2026-06-29

## What Changed

- Widened static param normalization in `@ferrite/runtime/server` to accept `string[]` values for catch-all params.
- Changed Rust page rendering and client bundling process-boundary props from string-only params to JSON-valued params.
- Changed dev route matching so catch-all params reach pages as arrays, and optional catch-all routes omit absent params.
- Changed production static path expansion to support catch-all and optional catch-all arrays.
- Kept path writes fail-closed by validating every generated segment against empty, `.`, `..`, `/`, and `\`.
- Added a real example docs catch-all route with `generateStaticParams`, `generateMetadata`, and typed `Ferrite.RouteParams`.
- Updated docs to reflect dynamic and catch-all static generation support.

## Why

Ferrite already scanned catch-all routes and generated route types that exposed `string[]`, but dev/build execution still used string-only params and production builds rejected catch-all static params. That mismatch made the generated TypeScript contract stronger than the runtime behavior. This milestone makes the route param shape consistent across generated types, dev rendering, production rendering, metadata collection, and client bundling.

## Verified

```sh
cargo test -p ferrite-page-renderer -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server -p ferrite-router
pnpm --filter @ferrite/runtime test
node packages/runtime/bin/render-page.mjs --static-params 'examples/basic/app/docs/[...slug]/page.tsx'
node packages/runtime/bin/render-page.mjs 'examples/basic/app/docs/[...slug]/page.tsx' '{"params":{"slug":["guide","intro"]}}' '["examples/basic/app/layout.tsx"]'
node packages/runtime/bin/render-page.mjs --metadata 'examples/basic/app/docs/[...slug]/page.tsx' '{"params":{"slug":["guide","intro"]}}' '["examples/basic/app/layout.tsx"]'
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
rg -n "<title>|meta name=\"description\"" examples/basic/.ferrite/build/docs/guide/intro/index.html examples/basic/.ferrite/build/docs/api/index.html
rg -n "page_metadata|Docs guide/intro|Docs api|Static docs route" examples/basic/.ferrite/build/ferrite-build.json
```

Observed proof:

- Focused Rust tests passed: page renderer 9 tests, client bundler 4 tests, builder 12 tests, dev server 14 tests, router 4 tests.
- Runtime tests passed: 37 tests.
- The real docs route returned `{"has_generate_static_params":true,"params":[{"slug":["guide","intro"]},{"slug":["api"]}]}` from `--static-params`.
- The real docs route rendered a layout-wrapped serialized tree containing `Docs guide/intro` when passed `slug: ["guide", "intro"]`.
- The real docs route metadata returned `{"title":"Docs guide/intro","description":"Static docs route for guide/intro."}`.
- Builder tests prove required catch-all output, optional catch-all output with absent params, and unsafe catch-all segment rejection.
- Dev-server tests prove catch-all arrays and optional catch-all routes without segments.
- Full workspace tests, lint, build, typecheck, render fixture, dev one-shot, and production example build passed.
- Example typecheck generated `"/docs/*slug": { "slug": string[] }`.
- Production example build wrote 3 routes, 5 HTML files, 5 client bundles, 0 skipped dynamic routes.
- Production docs HTML includes `/docs/guide/intro` and `/docs/api` outputs with expected title, description, and route body.
- Production manifest includes `page_metadata` entries for both generated docs routes.

## Not Proven Yet

- Duplicate static output detection is not implemented; two generated param entries can still target the same output path.
- Optional catch-all routes are covered in unit tests, but the example app only includes a required catch-all docs route.
- Catch-all params are represented as JSON values at the process boundary; there is still no native or WASM route-param ABI.
