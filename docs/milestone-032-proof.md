# Milestone 032 Proof: Client Reference Browser Chunks

## What Changed

- Extended `ClientReference` with optional `script`, `styles`, `outputs`, `sourcemaps`, and `assets` fields.
- Updated `packages/runtime/bin/build-client.mjs` to emit a browser chunk for each discovered server-route client reference.
- Client-reference chunks register their component on `globalThis.__FERRITE_CLIENT_REFERENCES__` for a future island loader.
- Aggregated client-reference output files into the parent route bundle while keeping the server route's top-level `script: null`.
- Kept whole-route client output unchanged for routes whose page or layout starts with `"use client"`.

## Why

The previous milestone proved that Rust can preserve server-to-client module boundaries in `ferrite-build.json`. This milestone makes those references concrete browser artifacts. It is still not island hydration, but it gives the framework a real emitted chunk and manifest address for each client component reference.

## Verification

- `cargo fmt --all`
- `cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server`
- `pnpm --filter @ferrite/runtime build`
- `pnpm --filter ferrite-basic-example typecheck`
- `cargo run -p ferrite-cli -- build --project examples/basic`
- `node - <<'NODE' ... inspect examples/basic/.ferrite/build/ferrite-build.json client_bundles ... NODE`
- `find examples/basic/.ferrite/build/_ferrite/static -maxdepth 2 -type f | sort`
- `rg -n "client-reference|clientReferences|data-client-island|route-posts|route-index|/_ferrite/static" examples/basic/.ferrite/build/ferrite-build.json examples/basic/.ferrite/build/posts/alpha/index.html examples/basic/.ferrite/build/index.html examples/basic/.ferrite/build/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js`

Focused coverage includes:

- Normal path: the home route still emits `route-index.js`, `route-index.css`, source maps, and the imported SVG asset.
- Client reference path: generated post routes keep `script: null`, but their `clientReferences` entries include `/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js`.
- Static output path: the final static directory includes `client-reference-app-posts-id-PostActions-tsx-default.js` and its source map.
- Runtime hook path: the emitted client-reference JS contains the `PostActions` component and registers it in `globalThis.__FERRITE_CLIENT_REFERENCES__`.
- Route isolation path: post HTML remains server-rendered and does not include a route-level `/_ferrite/static/route-posts...` script tag.
- Failure path: existing client bundler, builder, and dev-server failure tests still pass after the bundle shape changed.

## Not Yet Proven

- Client-reference chunks are not automatically injected, loaded, or hydrated.
- Server output still executes imported client components for HTML; there is no RSC payload or client-reference proxy yet.
- The runtime registry is a low-level hook, not a public island API.
- CSS emitted by future client-reference chunks is recorded in the manifest but not loaded by an island runtime yet.
