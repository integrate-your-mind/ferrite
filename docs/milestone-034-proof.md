# Milestone 034 Proof: Automatic Client Reference Proxies

## Changed

- Added `createClientReference()` to `@ferrite/runtime/server`.
- Added a `render-page.mjs` esbuild plugin that replaces nested `"use client"` modules with server-side client-reference proxies.
- Removed the manual island wrapper from `examples/basic/app/posts/[id]/page.tsx`.
- Added runtime tests for normal, failure, and duplicate client-reference render paths.
- Added real `render-page.mjs` integration tests for nested client-module proxying and route-entry `"use client"` exclusion.

## Why

Milestone 033 proved client-reference chunks could hydrate manually marked islands. The remaining gap was app ergonomics and correctness: a server route importing a client component should not hand-author `data-ferrite-client-reference` or duplicate JSON prop serialization. The server renderer now owns that marker.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm build:example`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`
- `rg -n "data-ferrite-client-reference|data-ferrite-client-props|client-reference|/_ferrite/static/route-posts|/_ferrite/static/route-index" examples/basic/.ferrite/build/posts/alpha/index.html examples/basic/.ferrite/build/index.html examples/basic/.ferrite/build/ferrite-build.json`
- `rg -n "hydrateClientReference|__FERRITE_CLIENT_REFERENCES__|PostActions|client-reference" examples/basic/.ferrite/build/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js`
- Direct emitted-chunk hydration proof with Happy DOM returned `{"hydrated":"true","text":"Like proof: 1"}`.

Artifact check after `pnpm build:example`:

```json
{"hasMarker":true,"hasProps":true,"hasReferenceScript":true,"hasRouteScript":false,"fallbackButton":true}
```

## Coverage

- Normal path: a server route importing a nested `"use client"` component renders a marker, serialized props, and fallback button HTML automatically.
- Failure path: non-JSON-serializable client-reference props reject before producing misleading markup.
- Odd path: duplicate references to the same client module render separate markers with separate serialized props.
- Boundary path: a route entry file that itself starts with `"use client"` is not rewritten into an island proxy.
- Production path: `/posts/alpha` includes the client-reference script and automatic marker while still avoiding a route-level `route-posts` script.

## Not Proven

- This is not a React Server Components transport.
- Client-reference props must still be JSON-serializable; `children` are rendered as fallback HTML but are not serialized to the browser component.
- The proxy export parser supports ordinary default/named exports; it is not a complete JavaScript module parser.
