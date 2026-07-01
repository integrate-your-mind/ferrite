# Milestone 030 Proof: Directive-Gated Route Hydration

## What Changed

- Made the JS browser bundler inspect the matched page and layout chain for a leading `"use client"` directive before running esbuild.
- Server-only routes now return a bundle record with `script: null`, empty output lists, and no generated route assets.
- Updated Rust build and dev rendering to inject route stylesheet/script tags only when the client bundle contains a route script.
- Kept the dev reload client active for every dev HTML route, including server-only routes.
- Cleared the production static client output directory before rebuilding so stale scripts cannot survive when a route becomes server-only.
- Marked the example home route with `"use client"` because it uses `useState`; other example routes remain server-rendered only.

## Why

Ferrite needs a real server/client boundary before it can grow toward React Server Components. This milestone keeps the boundary intentionally simple and testable: routes are server-first, and `"use client"` opts the whole matched route into browser hydration. That proves the Rust orchestration can preserve server-only routes through manifests, document rendering, dev output, and production static output without pretending this is full per-component RSC support yet.

## Verification

- `cargo fmt --all`
- `cargo test -p ferrite-client-bundler -p ferrite-builder -p ferrite-dev-server`
- `pnpm --filter ferrite-basic-example typecheck`
- `pnpm --filter @ferrite/runtime build`
- `cargo run -p ferrite-cli -- build --project examples/basic`
- `find examples/basic/.ferrite/build/_ferrite/static -maxdepth 2 -type f | sort`
- `node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync("examples/basic/.ferrite/build/ferrite-build.json","utf8")); console.log(JSON.stringify(m.client_bundles.map((b,i)=>({i,script:b.script,outputs:b.outputs})),null,2));'`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /posts/abc`
- `cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /`

Focused coverage includes:

- Normal path: the example home route starts with `"use client"` and emits `route-index.js`, `route-index.css`, source maps, and the imported SVG asset.
- Server-only path: the other eight built example route outputs record `script: null` and empty output lists.
- Stale-output path: a seeded stale static file was removed by the production build; the final static directory contains only the home route bundle outputs.
- Dev server path: `/posts/abc` includes `/__ferrite/client.js` for reload behavior but no `/_ferrite/static` route script, while `/` includes both the reload client and `route-index.js`.
- Failure path: existing bundler failure tests still report client bundle failures as 500s or build errors after `script` became optional.

## Not Yet Proven

- `"use client"` still hydrates the whole matched route, not per-component islands.
- There is no server component payload, client reference manifest, or RSC wire transport.
- The directive parser is intentionally small; it handles leading whitespace, line comments, block comments, BOMs, and quoted directives, but it is not a full JavaScript parser.
- Production dynamic streaming is still not implemented; static builds still write final HTML.
