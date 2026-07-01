# Milestone 011 Proof

Date: 2026-06-29

## What Changed

- Added app-directory layout discovery to `ferrite-router`.
- Added `layouts: Vec<PathBuf>` to route manifests.
- Changed Rust page rendering to pass layout chains to the TSX page runner.
- Changed Rust client bundling to pass layout chains to the browser bundle runner.
- Changed `render-page.mjs` to compile a temporary page-plus-layout entry.
- Changed `@ferrite/runtime/server` to compose page output through layout modules.
- Changed `build-client.mjs` to hydrate the same layout-wrapped tree that SSR emits.
- Updated the example app layout to a root shell component rendered inside Ferrite's root container.

## Why

Next-style app routes need shared shells around page content. Rust should discover the route's layout chain and preserve it in manifests, while the JS bridge composes user-authored TSX layout components for SSR and browser hydration.

## Verified

```sh
cargo fmt --all -- --check
cargo test -p ferrite-page-renderer -p ferrite-client-bundler -p ferrite-router -p ferrite-builder -p ferrite-dev-server
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs examples/basic/app/page.tsx '{"params":{}}' '["examples/basic/app/layout.tsx"]'
node packages/runtime/bin/build-client.mjs examples/basic/app/page.tsx examples/basic/.ferrite/probe-static /_ferrite/static / '{"params":{}}' '["examples/basic/app/layout.tsx"]'
pnpm dev:once
pnpm build:example
```

Observed proof:

- Direct page rendering returned a serialized `<section data-layout="root">` wrapping the home page.
- Direct client bundling still emitted route JS, CSS, source maps, and the SVG asset with the layout import included.
- `ferrite dev --once --request-path /posts/abc` returned `<section data-layout="root"><article ...>`.
- `ferrite build --project examples/basic` wrote `index.html`, `posts/alpha/index.html`, and `posts/beta/index.html` with the root layout wrapper.
- `ferrite-build.json` records the root `layout.tsx` file on both routes.

The Rust tests prove:

- Route scanning discovers inherited layouts, including layouts inside route groups.
- Page renderer passes layout paths to the runner.
- Client bundler passes layout paths to the runner.
- Builder, dev-server, static params, client bundling, binary static serving, and route manifests still pass their focused tests.

## Not Proven Yet

- Layouts are component shells inside Ferrite's root container; document-level `<html>` and `<body>` ownership is not implemented.
- Metadata composition is not implemented.
- Nested layout hooks beyond direct layout function calls still need a fuller server component rendering model.
- Parallel/intercepting routes and route loading/error boundaries are not implemented.
