# Milestone 035 Proof: Production Stream HTTP Adapter

## Changed

- Added `ProductionServerConfig` and `ProductionProject` to the server crate.
- Added production TCP entry points: `serve_production`, `serve_production_listener`, and `serve_production_listener_once`.
- Added a `ferrite serve` CLI command with `--once`, host/port, client asset output, and public asset prefix options.
- Reused the existing stream response model so production sockets emit `Transfer-Encoding: chunked` only when route rendering produces deferred chunks.
- Kept production HTML free of dev reload state: no `/__ferrite/client.js`, no dev manifests, and no `data-ferrite-build-id`.

## Why

Static builds prove deterministic output, but a Next-style framework also needs a request-time production path for dynamic routes and streamed server output. This milestone adds a production-shaped adapter without changing the dev server contract or pretending static output is enough.

## Proof

- `cargo test -p ferrite-dev-server`
- `cargo test -p ferrite-cli`
- `pnpm --filter @ferrite/runtime build && cargo run -p ferrite-cli -- serve --project examples/basic --once --request-path /posts/abc`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

The real example `serve --once` response for `/posts/abc` contained `id="ferrite-root"`, `data-route="/posts/abc"`, `data-route-pattern="/posts/:id"`, the automatic client-reference island marker, and the client-reference script. It did not include `/__ferrite/client.js` or `data-ferrite-build-id`.

Final invariant check:

```json
{"hasRoot":true,"hasRoute":true,"hasPattern":true,"hasIsland":true,"hasReferenceScript":true,"hasDevClient":false,"hasBuildId":false}
```

## Coverage

- Normal path: production adapter renders dynamic routes on demand and injects production client scripts/assets.
- Failure path: page-render failures return a production 500 document without dev build state.
- Odd path: a route with stream chunks is sent over chunked HTTP on a real TCP socket.
- Asset path: generated client assets are served from the production client asset directory.

## Not Proven

- This is not yet a deployment target with compression, TLS, or long-running concurrency controls.
- Request body handling, non-GET methods beyond 405, and production observability are not implemented.
- The adapter scans routes once at startup; it intentionally does not hot-reload app files like `ferrite dev`.
