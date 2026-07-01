# Milestone 033 Proof: Explicit Client Island Hydration

## What Changed

- Added `hydrateClientReference()` to `@ferrite/runtime/dom`.
- Added runtime tests for matching island hydration, missing markers, and malformed serialized props.
- Updated client-reference chunks to register their component and hydrate matching DOM markers after the document is ready.
- Injected client-reference scripts and styles into production and dev document output while preserving route-level `script: null`.
- Added explicit island markers to the example post route with `data-ferrite-client-reference` and JSON `data-ferrite-client-props`.
- Added an esbuild runtime alias so generated chunks do not bundle separate runtime instances for `@ferrite/runtime`, `@ferrite/runtime/dom`, and `@ferrite/runtime/jsx-runtime`.

## Why

Ferrite had client-reference manifests and emitted chunks, but those chunks were not loaded or hydrated. This milestone turns the manifest/chunk boundary into an actual interactive island path without hydrating the whole route. The contract is still explicit: server HTML must mark the island container and provide serializable props.

## Verification

- `pnpm --filter @ferrite/runtime build && pnpm --filter @ferrite/runtime test`
- `cargo fmt --all && cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server`
- `pnpm --filter ferrite-basic-example typecheck`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /posts/abc`
- `pnpm --filter @ferrite/runtime build && cargo run -p ferrite-cli -- build --project examples/basic`
- `node - <<'NODE' ... inspect examples/basic/.ferrite/build/ferrite-build.json client_bundles ... NODE`
- `rg -n "data-ferrite-client-reference|data-ferrite-client-props|client-reference|__FERRITE_CLIENT_REFERENCES__|hydrateClientReference|/_ferrite/static/route-posts|/_ferrite/static/route-index" examples/basic/.ferrite/build/posts/alpha/index.html examples/basic/.ferrite/build/index.html examples/basic/.ferrite/build/ferrite-build.json examples/basic/.ferrite/build/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js`
- Direct generated-chunk proof in Happy DOM:
  `node --input-type=module ... import client-reference-app-posts-id-PostActions-tsx-default.js ...`

Focused coverage includes:

- Normal path: `hydrateClientReference()` hydrates a matching marker, preserves the server button node, and updates state after a click.
- Missing marker path: `hydrateClientReference()` returns an empty handle list and leaves DOM unchanged.
- Failure path: malformed `data-ferrite-client-props` fails with a clear JSON props error.
- Generated chunk path: importing the built `client-reference-app-posts-id-PostActions-tsx-default.js` marks the island hydrated and a click changes `Like proof: 0` to `Like proof: 1`.
- Dev path: `/posts/abc` includes `/__ferrite/client.js`, the client-reference script, the marker, and serialized `{"id":"abc"}` props.
- Production path: `/posts/alpha` includes the client-reference script and explicit marker, while still not including a route-level `route-posts...` script.
- Regression path: the duplicate runtime-instance bug was reproduced by direct generated-chunk import, then fixed by aliasing all generated browser-bundle `@ferrite/runtime` imports to the same source runtime.

## Not Yet Proven

- Server rendering does not automatically wrap imported client components with markers; the example uses explicit markup.
- There is still no React Server Components payload or client-reference proxy transform.
- Island props are limited to manually serialized JSON object props.
- CSS emitted by client-reference chunks is injected by route output, but there is no lazy CSS loader.
