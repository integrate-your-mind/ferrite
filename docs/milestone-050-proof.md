# Milestone 050 Proof: Immutable Production Asset Fingerprints

## Changed

- Added production-only fingerprinting for generated route JS/CSS and client-reference JS/CSS outputs.
- Rewrote production HTML, build manifest entries, client-reference metadata, and output lists to use the fingerprinted public paths.
- Removed stale production static output before production route snapshots are built.
- Served fingerprinted production static assets with `Cache-Control: public, max-age=31536000, immutable`.
- Kept non-fingerprinted static asset responses on `public, max-age=0, must-revalidate`.
- Tightened hash-aware cache detection so ordinary hyphenated filenames are not treated as immutable.

## Why

Milestone 049 added response compression, but generated production assets still used stable names and conservative cache headers. This milestone makes production asset names content-addressed so browsers and CDNs can cache them long term without serving stale route or island code.

## Proof

- `cargo fmt --all && cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Route JS/CSS files renamed to dot-hex fingerprinted filenames.
- Client-reference JS/CSS files renamed and reflected in `ferrite-build.json`.
- Production HTML references the fingerprinted script and stylesheet URLs.
- Stale production static assets are removed before a production build snapshot.
- Fingerprinted production assets get immutable cache headers.
- Unknown or non-fingerprinted static files keep conservative revalidation headers.
- Server-only routes still omit route assets and clean stale static output.

Artifact spot-check after `pnpm build:example`:

- `examples/basic/.ferrite/build/_ferrite/static/route-index.3fb6443fab18ff50.js`
- `examples/basic/.ferrite/build/_ferrite/static/route-index.c6a90b35e3e2df2e.css`
- `examples/basic/.ferrite/build/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.799ba6e1ce195237.js`
- `examples/basic/.ferrite/build/_ferrite/static/assets/mark-NZYE5HIS.svg`

## Not Proven

- CDN deployment integration is not implemented.
- Asset manifest signing is not implemented.
- Runtime module preload generation is not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
