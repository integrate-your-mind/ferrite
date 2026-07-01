# Milestone 031 Proof: Server Route Client Reference Manifest

## What Changed

- Added `ClientReference` and `clientReferences` to the Rust `ClientBundle` model.
- Taught `packages/runtime/bin/build-client.mjs` to scan server-route relative imports for `"use client"` boundaries.
- Server routes now keep `script: null` while recording imported client module/export references in `ferrite-build.json`.
- Added a real example client component at `examples/basic/app/posts/[id]/PostActions.tsx`.
- Updated the server-rendered post route to import that client component without opting the whole route into route hydration.
- Added focused tests for real JS runner discovery and Rust build-manifest serialization.

## Why

Ferrite needs a durable server/client reference artifact before it can hydrate islands. The previous milestone distinguished whole-route client hydration from server-only routes. This milestone adds the next smaller boundary: a server route can import a separate `"use client"` module, and Rust preserves that reference in the production manifest without emitting a whole-route script.

## Verification

- `cargo fmt --all`
- `cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server`
- `pnpm --filter ferrite-basic-example typecheck`
- `pnpm --filter @ferrite/runtime build`
- `cargo run -p ferrite-cli -- build --project examples/basic`
- `node - <<'NODE' ... inspect examples/basic/.ferrite/build/ferrite-build.json client_bundles ... NODE`
- `rg -n "PostActions|clientReferences|data-client-island|route-posts|route-index|/_ferrite/static" examples/basic/.ferrite/build/ferrite-build.json examples/basic/.ferrite/build/posts/alpha/index.html examples/basic/.ferrite/build/index.html`
- `find examples/basic/.ferrite/build/_ferrite/static -maxdepth 2 -type f | sort`

Focused coverage includes:

- Normal path: a whole-route client page still emits `route-index.js` and related assets.
- Server route path: `/posts/alpha` and `/posts/beta` still record `script: null`.
- Client reference path: both generated post routes record `app/posts/[id]/PostActions.tsx#default` in `clientReferences`.
- Static output path: post HTML includes the server-rendered button markup but no route script tag.
- Stale output path: the final static directory still contains only the home route bundle outputs.
- Failure path: existing bundler and dev/build client-bundle failure tests still pass after the bundle shape changed.

## Not Yet Proven

- Client references are not bundled into separate island browser chunks yet.
- The server renderer still executes the imported client component for HTML output; there is no client-reference proxy or RSC payload yet.
- The import scanner is intentionally narrow: it follows relative source imports and re-exports, but it is not a full TypeScript compiler graph.
- Runtime island hydration is not implemented.
