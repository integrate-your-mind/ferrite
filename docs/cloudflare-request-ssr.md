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

The experimental generator derives each route's source identity from the exact
transitive project and Ferrite runtime bytes consumed by esbuild. It rejects
imports outside those receipt roots, rechecks every input after each build
pass, derives a canonical module identity with one fixed-width sentinel, and
writes `<route>.receipt.json` with the final module size and SHA-256. A
caller-supplied `sourceBuildId` is only an assertion and is rejected when stale;
it never selects the identity.

The artifact also embeds a metadata identity derived from the route path,
fallback path, asset identity, source identity, schema version, and observed
action inventory. Receipt verification recomputes that value and requires it
to occur exactly once in the final module, so rewriting receipt claims after
the build fails closed.

Before request-time rendering, the adapter fetches the deployed
`/ferrite-server.json` through `ASSETS`, hashes its exact bytes against the
identity embedded in the Worker entry, and requires the final asset identity,
per-route source/metadata/module receipt fields, and exact action-free route-to-prerender
mapping. The local verifier generates that manifest from validated receipts.
This prevents a stale or independently replaced asset manifest from silently
authorizing request rendering. An attacker authorized to replace both Worker
code and assets remains outside this unsigned local-spike threat model.

## Local Workerd Proof

The repository pins Wrangler `4.115.0` and its workerd runtime through the root
lockfile. After a frozen install, run the dedicated gate:

```sh
pnpm test:cloudflare-worker
```

The verifier rebuilds the runtime and release-profile Rust WASM, creates an
isolated deterministic fixture, generates four edge route artifacts, and runs
`wrangler deploy --dry-run`. It then revalidates every receipt against the
post-bundle route artifact, requires each artifact and metadata/module identity
in Wrangler's metafile and emitted modules, and starts
`wrangler dev --local --no-bundle` from that exact inventoried output. It then
observes two distinct request-time renders in the same isolate and checks:

- exact deep-route refresh plus `HEAD`
- static-asset passthrough and missing assets
- route-exception, response-deadline, and rendered-server-action fallback
- unsupported methods, representations, and payload streaming
- encoded traversal and separator rejection
- Git HEAD/tree/cleanliness, route receipts, manifest/config/lockfile identities,
  bounded emitted bundle/WASM identities, and descendant cleanup

A passing receipt proves that fixture in the pinned local workerd version. It
does not prove a Cloudflare deployment, production traffic, cross-platform
parity, or a hosted Buildkite result. The root `pnpm test` command includes this
gate, so the existing Buildkite `verify` step will execute it when the dedicated
Ferrite agent is available.

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
  '{"assetBuildId":"sha256:<64 lowercase packaged-manifest hex characters>","fallbackPath":"/index.html","observedActions":[]}'
```

The command emits `dist/server/home.mjs` plus
`dist/server/home.mjs.receipt.json`. Verify the pair before Worker bundling:

```sh
node packages/runtime/bin/render-page.mjs \
  --verify-cloudflare-artifact-receipt \
  dist/server/home.mjs
```

The build uses an isolate-oriented ESM target and fails if application code
imports a Node built-in or resolves transitive source outside the project and
Ferrite runtime receipt roots. The only external allowed by this first profile
is `node:async_hooks` from Ferrite's own server runtime.
`PROFILE=release pnpm --filter @ferrite/protocol-wasm build` builds the
release-profile WASM used for bundle-size and production proof.

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
  assetManifestSha256: "sha256:<exact ferrite-server.json bytes>",
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
- Fallback requests strip range and conditional headers and accept only a full
  `200` `text/html` document. A missing, throwing, partial, conditional,
  wrong-media-type, or non-success fallback produces a generic no-store `500`
  or `504` without exposing the route error.
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
- Rust production-builder integration for the edge receipt and Worker entry
- A signed release manifest for a threat model where one actor can replace both Worker and assets
- Cross-platform Wrangler parity or a hosted Buildkite Worker-runtime gate

The next promotion gate is a passing local workerd/Wrangler receipt bound to the
exact committed fixture, followed by exact-head Buildkite proof. Deployment
remains a separate authorization boundary.
