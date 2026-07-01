# Milestone 007 Proof

Date: 2026-06-29

## What Changed

- Added `ferrite-client-bundler`, a Rust crate that calls the browser bundle runner and parses its JSON output.
- Added `packages/runtime/bin/build-client.mjs`, an esbuild-based browser bundle runner for TSX page modules.
- Changed `ferrite dev` route responses to emit per-route client bundles and inject generated CSS/script tags.
- Changed `ferrite build` static output to emit client JS, CSS, source maps, and imported assets under `/_ferrite/static`.
- Changed dev static asset serving from UTF-8 `String` bodies to byte bodies so binary assets can be served without corruption.
- Added CSS and SVG imports to the example app to prove non-JS assets flow through server render, browser bundling, dev serving, and static build output.
- Mapped JSX `className` and `htmlFor` props to HTML `class` and `for` in serialized output.
- Updated CLI build output to report the number of emitted client bundles.

## Why

The framework needs the server output and browser runtime to be connected by real page-specific bundles. This milestone keeps Rust in charge of routing, dev/build orchestration, static output, and error handling, while using a narrow JS bundler bridge for the JavaScript-native module graph.

## Verified

```sh
cargo fmt --all -- --check
cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server -p ferrite-cli
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs examples/basic/app/page.tsx '{"params":{}}'
node packages/runtime/bin/build-client.mjs examples/basic/app/page.tsx examples/basic/.ferrite/probe-static /_ferrite/static / '{"params":{}}'
pnpm dev:once
pnpm build:example
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /_ferrite/static/route-index.css
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /_ferrite/static/assets/mark-NZYE5HIS.svg
```

Observed proof:

- Direct page rendering produced a serialized VNode with `class: "home-shell"` and `Count: 0`.
- Direct client bundling emitted `route-index.js`, `route-index.css`, both source maps, and `assets/mark-NZYE5HIS.svg`.
- `ferrite dev --once --request-path /posts/abc` rendered the dynamic TSX route and injected the route client script.
- `ferrite dev --once --request-path /` rendered the static TSX route and injected both `route-index.css` and `route-index.js`.
- Dev static serving returned the generated CSS with the rewritten `url("./assets/mark-NZYE5HIS.svg")`.
- Dev static serving returned the generated SVG asset body.
- `ferrite build --project examples/basic` wrote `index.html` with stylesheet/script tags and a manifest recording the emitted client bundle, source maps, and SVG asset.

The Rust tests prove:

- Client bundler JSON output is parsed and bundler failures are surfaced.
- Builder injects client styles/scripts for static routes and fails when client bundling fails.
- Dev server injects client styles/scripts, returns 500 on page render failures, returns 500 on client bundle failures, and serves generated JS.
- Dev server serves binary generated assets without UTF-8 conversion.
- Dev server rejects parent segments in static asset paths.
- Route matching, rebuild detection, manifests, type generation, dynamic route skipping, and real HTTP response writing still work.

## Not Proven Yet

- Browser reconciliation is still a full rerender after state updates.
- `useEffect`, cleanup, transitions, and scheduling are not implemented.
- Static parameter generation for dynamic routes is not implemented.
- Layout and metadata composition are not implemented.
- Client bundle cache invalidation is basic and will need stronger graph-aware invalidation.
- The page execution and bundling bridges still shell out to Node instead of a native NAPI/WASM boundary.
