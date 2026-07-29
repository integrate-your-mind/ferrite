# Cloudflare Request-Time SSR Compatibility Spike

Status: experimental, source-level vertical slice. It is not deployed and does not make every Ferrite app Worker-compatible.

Ferrite's established Cloudflare Sites output serves prerendered HTML and client assets. That static path remains the production default. The separate adapter described here proves a narrower boundary: a Worker can execute an allowlisted Ferrite route module during `fetch`, render its compact packet with Rust-backed WASM, and fall back to the exact prerendered file before committing a response.

## What Executes In The Worker

The request-time path contains:

1. A self-contained route ESM artifact generated with `render-page.mjs --build-cloudflare-artifact`.
2. The route's bundled `serverRuntime`, page, layouts, optional document, and error/loading conventions.
3. `@ferrite/runtime/cloudflare`, which owns Fetch request validation, exact route registration, deadlines, byte limits, abort handling, and static fallback.
4. `@ferrite/protocol-wasm`, whose Rust `ferrite-ssr` dependency validates the compact render packet and produces canonical escaped HTML.
5. Cloudflare's `ASSETS` binding for non-route assets, rollback, and same-route prerender fallback.

No Node subprocess, Rust native executable, Node-API addon, origin rendering service, or hidden network render hop is used. `ferrite-page-renderer` and `render-artifact.mjs` remain the native Node production path and do not run inside Workers.

## Initial Compatibility Tier

The first tier deliberately accepts only:

- exact, static `GET` and `HEAD` routes registered through static ESM imports
- route modules whose edge build has no Node built-ins except Ferrite runtime's `node:async_hooks`
- Cloudflare Workers configured with `nodejs_compat`
- routes whose generated artifact records no build-observed server actions and whose rendered packet contains no action controls
- HTML responses with a declared, same-route prerender fallback
- buffered compact render packets and buffered HTML within explicit byte and wall-time limits

It rejects dynamic/catch-all route patterns, server actions, reserved payload-stream requests, unsupported methods or representations, malformed and encoded separator/traversal paths, and application imports of Node built-ins. These are compatibility constraints, not future-complete claims.

The current Ferrite stream API resolves every deferred Suspense chunk before it returns a packet. The Worker adapter therefore does not claim progressive SSR streaming. A deadline or aborted request abandons the response path, but JavaScript cannot forcibly cancel an arbitrary user promise that ignores `AbortSignal`.

Every generated route artifact embeds the source artifact `buildId`, the final packaged asset `buildId`, fallback path, and observed-action inventory. Before request-time rendering, the adapter fetches the deployed `/ferrite-server.json` through `ASSETS` and requires the final asset identity plus the exact action-free route-to-prerender mapping. This prevents request-time HTML from running against a stale client/fallback asset set. The production generator must supply both identities from its already validated source and packaged manifests; hand-authored identities are not release evidence.

## Build A Route Artifact

Build the protocol WASM and runtime first, then generate one edge-profile route module:

```sh
pnpm --filter @ferrite/protocol-wasm build
pnpm --filter @ferrite/runtime build
node packages/runtime/bin/render-page.mjs \
  --build-cloudflare-artifact \
  app/page.tsx \
  dist/server/home.mjs \
  '[]' \
  '"app/document.tsx"' \
  '{}' \
  / \
  '{"sourceBuildId":"sha256:<64 lowercase source-manifest hex characters>","assetBuildId":"sha256:<64 lowercase packaged-manifest hex characters>","fallbackPath":"/index.html","observedActions":[]}'
```

The build uses an isolate-oriented ESM target and fails if application code imports a Node built-in. The only external allowed by this first profile is `node:async_hooks` from Ferrite's own server runtime. `PROFILE=release pnpm --filter @ferrite/protocol-wasm build` builds the release-profile WASM used for bundle-size and production proof.

## Worker Entry

Route imports must be static so Wrangler can discover and bundle the complete module graph:

```ts
import * as route from "./generated/home.mjs";
import ferriteWasm from "@ferrite/protocol-wasm/ferrite_protocol_wasm.wasm";
import { instantiateFerriteProtocolWasm } from "@ferrite/protocol-wasm";
import { createCloudflareSsrHandler } from "@ferrite/runtime/cloudflare";

const renderer = await instantiateFerriteProtocolWasm(ferriteWasm);

export default createCloudflareSsrHandler({
  routes: [{
    module: route,
    document: { rootId: "ferrite-root" },
  }],
  renderer,
  responseDeadlineMs: 50,
  maxPacketBytes: 2 * 1024 * 1024,
  maxHtmlBytes: 8 * 1024 * 1024,
  shouldRender(_request, env) {
    return env.FERRITE_SSR_ROLLBACK !== "1";
  },
});
```

Generated deployment code must retain those named exports. The adapter validates the embedded identity against the actual asset manifest before every request-time render.

Cloudflare configuration needs a current compatibility date, Node compatibility for `AsyncLocalStorage`, and Worker-first asset routing:

```toml
main = "src/worker.ts"
compatibility_date = "2026-07-28"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist/client"
binding = "ASSETS"
run_worker_first = true
```

Official constraints and configuration references:

- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Workers static assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Wrangler bundling and additional modules](https://developers.cloudflare.com/workers/wrangler/bundling/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Failure And Rollback Contract

- A malformed request, unsupported method, unsupported `Accept`, or payload-stream request never invokes the route or asset binding.
- A route exception, action control, invalid/oversized packet, invalid/oversized HTML, or deadline failure may fetch only that route's declared fallback path.
- An aborted request is rethrown as `AbortError`; it must not start fallback work.
- Fallback requests strip range and conditional headers and accept only a full `200` document. A missing, throwing, partial, conditional, or non-success fallback produces a generic no-store `500` or `504` without exposing the route error.
- `shouldRender` is the rollback gate. Returning `false` bypasses request rendering and serves the declared prerender.
- Unknown paths and declared static assets remain owned by `env.ASSETS`.

`responseDeadlineMs` bounds manifest verification plus request rendering. A fallback binding gets a fresh deadline of the same duration so recovery remains possible after a render timeout. These are response deadlines, not CPU budgets or forced-cancellation guarantees: synchronous code or a non-cooperative promise can continue after the response path has selected fallback.

## Not Yet Proven

- Actual production deployment or traffic on Cloudflare
- Dynamic and catch-all params
- Request/cookie/header APIs inside components
- Server actions, uploads, or mutation authentication
- Progressive HTML or payload streaming
- Forced cancellation of non-cooperative component work
- Distributed data caches, tracing, or multi-region consistency
- Worker bundle size, CPU, and memory headroom for a real application corpus
- Production generation that records the edge route-module digest in the immutable artifact receipt
- Cross-platform Wrangler parity or a hosted Buildkite Worker-runtime gate

The next promotion gate is a local workerd/Wrangler run of the exact committed fixture followed by exact-head Buildkite proof. Deployment remains a separate authorization boundary.
