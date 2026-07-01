# Milestone 036 Proof: Production Cache and Route Metadata Headers

## Changed

- Extended server responses with optional `Cache-Control` and `X-Ferrite-Route-Pattern` metadata.
- Production HTML route responses and production error responses now use `Cache-Control: no-store`.
- Production generated client assets now use `Cache-Control: public, max-age=0, must-revalidate`.
- Production route responses expose the matched route pattern through `X-Ferrite-Route-Pattern`.
- `ferrite serve --once --json` includes cache and route-pattern metadata for deterministic checks.

## Why

Milestone 035 made request-time production serving real, but responses still lacked explicit cache and deployment metadata. This milestone keeps the default safe: HTML is not cached, generated assets require revalidation until route assets are content-hashed, and route pattern metadata is available to production adapters/logging without scraping HTML.

## Proof

- `cargo fmt --all && cargo test -p ferrite-dev-server -p ferrite-cli`
- `pnpm --filter @ferrite/runtime build && cargo run -p ferrite-cli -- --json serve --project examples/basic --once --request-path /posts/abc`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Real example JSON invariant:

```json
{"status":200,"cacheControl":"no-store","routePattern":"/posts/:id","hasDevClient":false,"hasIsland":true}
```

## Coverage

- Normal path: production dynamic HTML responses carry `no-store` and the matched route pattern.
- Failure path: production render failures carry `no-store` and the matched route pattern.
- Odd path: chunked production stream responses include cache and route-pattern headers on a real TCP socket.
- Asset path: generated client assets carry conservative revalidation caching and no route-pattern header.

## Not Proven

- Route JS/CSS files are not content-hashed yet, so immutable caching is intentionally not enabled.
- Compression, TLS, CDN integration, and observability hooks remain out of scope.
- Header metadata is limited to route pattern and cache policy; it is not a full deployment manifest.
