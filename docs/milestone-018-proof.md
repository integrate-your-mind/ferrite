# Milestone 018 Proof

Date: 2026-06-29

## What Changed

- Added `DocumentModule`, `DocumentProps`, `DocumentRenderOptions`, and `renderDocumentModule()` to `@ferrite/runtime/server`.
- Added `--document` mode to `packages/runtime/bin/render-page.mjs`.
- Added root `app/document.tsx` discovery in `ferrite-router`.
- Added `PageRenderer::render_document_to_html()` with doctype-prefixed Rust SSR output.
- Wired `ferrite-builder` and `ferrite-dev-server` to render `app/document.tsx` when present and preserve the existing Rust wrapper fallback when absent.
- Added `examples/basic/app/document.tsx` so the example app owns `<html>`, `<head>`, and `<body>`.
- Kept hydration stable by passing `children` to the document as the framework root div containing the page/layout tree.

## Why

Ferrite needs app-level document ownership before it can behave like a complete app framework. The new contract lets app code own the outer document while Ferrite still supplies metadata, styles, scripts, reload wiring, and the hydration root needed by the runtime.

## Verified

```sh
cargo fmt --all
pnpm --filter @ferrite/runtime test
cargo test -p ferrite-page-renderer -p ferrite-builder -p ferrite-dev-server -p ferrite-router
node packages/runtime/bin/render-page.mjs --document examples/basic/app/page.tsx '{"params":{}}' '["examples/basic/app/layout.tsx"]' examples/basic/app/document.tsx '{"rootId":"ferrite-root","routePath":"/","metadata":{"title":"Ferrite Home","description":"Interactive Ferrite home route."},"styles":["/_ferrite/static/app.css"],"scripts":["/_ferrite/static/app.js"],"defaultTitle":"Ferrite"}'
node packages/runtime/bin/render-page.mjs --document 'examples/basic/app/docs/[...slug]/page.tsx' '{"params":{"slug":["guide","intro"]}}' '["examples/basic/app/layout.tsx"]' examples/basic/app/document.tsx '{"rootId":"ferrite-root","routePath":"/docs/guide/intro","metadata":{"title":"Docs guide/intro","description":"Static docs route for guide/intro."},"styles":[],"scripts":["/_ferrite/static/docs.js"],"defaultTitle":"Ferrite"}'
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Observed proof:

- Runtime tests passed: 39 tests, including document head/root composition and non-`html` document rejection.
- Focused Rust tests passed: page renderer 11 tests, builder 17 tests, dev server 15 tests, router 5 tests.
- The real example document runner emitted `<html data-ferrite-document="custom">`, framework head tags, scripts/styles, and the hydration root for the home route.
- The real example document runner emitted the same document shell for the catch-all docs route with `slug: ["guide", "intro"]`.
- Builder tests prove custom document output, document render failure, and wrapper fallback behavior.
- Dev-server tests prove custom document output and existing error/static/client route behavior.
- Full workspace tests, lint, build, typecheck, render fixture, dev one-shot, and production example build passed.
- Production example build wrote 3 routes, 5 HTML files, 5 client bundles, and 0 skipped dynamic routes.
- Production home, docs, and post HTML now start with the custom document shell marker `data-ferrite-document="custom"`.
- Production document HTML includes Ferrite-managed title/description/style/script tags and the `id="ferrite-root"` hydration root.
- Production manifest still includes `page_metadata` entries for home, docs, and posts.

## Not Proven Yet

- `app/document.tsx` is app-root only; nested per-segment document files are not implemented.
- The document component can omit `{head}` or `{children}`; Ferrite does not yet statically or structurally enforce placement.
- Head content is still limited to the current metadata/style/script set.
