# Milestone 051 Proof: Production Asset Preload Hints

## Changed

- Added `preloadScripts` to the server document render options.
- Rendered `rel="modulepreload"` links for production route and client-reference scripts.
- Passed preload hints through production custom document rendering without changing dev reload HTML.
- Added Rust static document and production server HTML assertions for modulepreload tags.
- Added runtime coverage for custom document head composition with modulepreload links.

## Why

Milestone 050 made production assets content-addressed and safe for immutable caching. This milestone lets production HTML advertise those hashed scripts earlier while preserving the existing module script tags and stylesheet behavior.

## Proof

- `cargo fmt --all && cargo test -p ferrite-page-renderer -p ferrite-builder -p ferrite-dev-server && pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Rust document render options serialize `preloadScripts`.
- Runtime custom document heads render modulepreload links before stylesheet/script tags.
- Static build HTML includes a modulepreload for the emitted route script.
- Production server HTML includes a modulepreload for the emitted route script.
- Client-reference-only production routes include modulepreload links for hashed island scripts.
- Existing hashed asset cache and stale cleanup tests remain green.

Artifact spot-check after `pnpm build:example`:

- `examples/basic/.ferrite/build/index.html` includes `rel="modulepreload"` for `/_ferrite/static/route-index.162fb711e673fae3.js`.
- `examples/basic/.ferrite/build/posts/alpha/index.html` includes `rel="modulepreload"` for `/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.f478246cf61c26d8.js`.

## Not Proven

- HTTP `Link` headers are not implemented.
- CSS preload or async stylesheet loading is not implemented.
- CDN integration is not implemented.
- Asset manifest signing is not implemented.
- The payload format is not Flight-compatible.
- Server actions are not implemented.
