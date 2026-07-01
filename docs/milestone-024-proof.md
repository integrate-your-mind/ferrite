# Milestone 024 Proof: Route Loading and Error Conventions

## What Changed

- Added `loading` and `error` convention paths to Rust route records.
- Taught `ferrite-router` to find the nearest route `loading.{tsx,ts,jsx,js}` and `error.{tsx,ts,jsx,js}` files from the app root down to the page directory.
- Added `RouteConventions` to `ferrite-page-renderer` and passed convention files through page, stream, document, and document-stream render modes.
- Passed route conventions from `ferrite-builder` and `ferrite-dev-server` into the page renderer.
- Extended `@ferrite/runtime/server` so `loading.tsx` becomes the stream fallback and `error.tsx` catches page-tree render failures.
- Updated `render-page.mjs` to import discovered convention files and pass their modules into server rendering.
- Added real `/route-loading` and `/route-error` example routes.

## Why

Ferrite already had server `Suspense`, `ErrorBoundary`, app routing, and render streams. Route file conventions make those primitives framework-owned: Rust discovers the files, carries them in manifests, and the TS facade renders them at the correct page boundary.

## Verification

- `pnpm --filter @ferrite/runtime typecheck`
- `pnpm --filter @ferrite/runtime test`
- `cargo test -p ferrite-router -p ferrite-page-renderer -p ferrite-builder -p ferrite-dev-server`
- `pnpm --filter ferrite-basic-example typecheck`
- `cargo run -p ferrite-cli -- check --project examples/basic`
- `node packages/runtime/bin/render-page.mjs --stream examples/basic/app/route-loading/page.tsx '{}' '["examples/basic/app/layout.tsx"]' '{"loading":"examples/basic/app/route-loading/loading.tsx"}'`
- `node packages/runtime/bin/render-page.mjs examples/basic/app/route-error/page.tsx '{}' '["examples/basic/app/layout.tsx"]' '{"error":"examples/basic/app/route-error/error.tsx"}'`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /route-loading`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /route-error`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Normal path: route conventions are discovered, serialized, and passed into build and dev page rendering.
- Stream path: `/route-loading` emits a `render-stream` shell using `loading.tsx` plus a resolved async page chunk.
- Failure path: `/route-error` throws during page render and recovers through `error.tsx` in direct render and dev output.
- Odd path: nested route groups prefer the nearest convention file while still inheriting root conventions when no closer file exists.
- Compatibility path: existing render methods still default to empty conventions, so old call sites do not need to provide new arguments.

## Not Yet Proven

- Dev and production HTTP adapters still emit final HTML, not chunked transfer responses.
- `error.tsx` catches failures in the page subtree. Layout failures outside that wrapped page boundary still surface as render failures.
- The browser runtime does not run async client components; route loading is a server stream convention only.
