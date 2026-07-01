# Milestone 015 Proof

Date: 2026-06-29

## What Changed

- Added `metadata` and `generateMetadata` support to `@ferrite/runtime/server`.
- Added `--metadata` mode to `packages/runtime/bin/render-page.mjs`.
- Added Rust `PageMetadata` collection in `ferrite-page-renderer`.
- Injected escaped `<title>` and description `<meta>` tags into dev and build HTML.
- Added page metadata entries to the production build report and `ferrite-build.json`.
- Added example app metadata for the root layout, home page, and generated post pages.
- Added normal, failure, and odd-path tests for metadata merge/validation, runner errors, dev errors, and build output.

## Why

Apps need route-owned document metadata before Ferrite can behave like a useful app framework. This milestone keeps metadata intentionally small and validated: `title` and `description` only, composed from layouts root-to-leaf with the page winning last.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs --metadata examples/basic/app/page.tsx '{"params":{}}' '["examples/basic/app/layout.tsx"]'
node packages/runtime/bin/render-page.mjs --metadata 'examples/basic/app/posts/[id]/page.tsx' '{"params":{"id":"abc"}}' '["examples/basic/app/layout.tsx"]'
cargo test -p ferrite-page-renderer -p ferrite-builder -p ferrite-dev-server
pnpm --filter @ferrite/runtime test
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
rg -n "<title>|meta name=\"description\"" examples/basic/.ferrite/build/index.html examples/basic/.ferrite/build/posts/alpha/index.html examples/basic/.ferrite/build/posts/beta/index.html
rg -n "page_metadata|Post alpha|Ferrite Home|Static post route" examples/basic/.ferrite/build/ferrite-build.json
```

Observed proof:

- Runtime metadata collection returned `{"title":"Ferrite Home","description":"Interactive Ferrite home route."}` for the home page.
- Runtime metadata collection returned `{"title":"Post abc","description":"Static post route for abc."}` for a dynamic post page.
- Focused Rust metadata tests passed: page renderer 7 tests, builder 9 tests, dev server 13 tests.
- Runtime tests passed: 35 tests.
- Full workspace tests passed through `pnpm test`.
- Full lint passed through rustfmt check, clippy with warnings denied, and runtime typecheck.
- Workspace build passed.
- Example project typecheck passed through `ferrite check`.
- Dev one-shot HTML for `/posts/abc` included `<title>Post abc</title>` and the generated description meta tag.
- Production build wrote 3 HTML files, 3 client bundles, 0 skipped dynamic routes, and `ferrite-build.json`.
- Production HTML includes the expected home, `Post alpha`, and `Post beta` title/description tags.
- Production manifest includes `page_metadata` entries for generated routes.

## Not Proven Yet

- Metadata only supports `title` and `description`; Open Graph, icons, alternates, robots, and structured metadata are not implemented.
- Full document ownership is still fixed by Rust wrappers; app-level `<html>`, `<head>`, and `<body>` components are not implemented.
- Catch-all static params are still not generated for production builds.
- Metadata collection currently uses the same Node runner boundary as page rendering; no native or WASM metadata path exists yet.
