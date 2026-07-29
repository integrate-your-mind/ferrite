# Ferrite advanced example

This example is the framework's broader local feature fixture. It is useful
for inspecting route discovery, server-first rendering, client islands,
metadata, stream output, and failure boundaries from a Ferrite source checkout.
It is not a production application or a claim of complete React/Next.js
compatibility.

## Run from the repository root

Install dependencies, then check the example and render a deterministic fixture:

```sh
pnpm install
cargo run -p ferrite-cli -- check --project examples/basic
node examples/basic/render.mjs | cargo run -p ferrite-cli -- render --input -
```

Run the development server for one request, or keep it running for local
browser exploration:

```sh
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /posts/abc
cargo run -p ferrite-cli -- dev --project examples/basic --host 127.0.0.1 --port 3000
```

Build and serve the immutable production-shaped artifact:

```sh
cargo run -p ferrite-cli -- build --project examples/basic
cargo run -p ferrite-cli -- serve --project examples/basic \
  --artifact .ferrite/build \
  --page-renderer packages/runtime/bin/render-artifact.mjs \
  --once --request-path /posts/abc
```

The build and serve commands are separate on purpose: `build` compiles and
validates the artifact, while `serve` executes only that artifact. The example
does not require or imply a hosted deployment.

## Verified route map

| Route | What it demonstrates |
| --- | --- |
| `/` | A client-marked route with `useState` and a browser counter. |
| `/posts/:id` (for example `/posts/alpha`) | Static params, dynamic metadata, a client `PostActions` island, and an explicit form-based server action. |
| `/docs/*slug` (for example `/docs/guide/intro`) | Catch-all routing, `generateStaticParams`, and generated metadata. |
| `/stream-demo` | Server `Suspense` fallback and resolved stream content. |
| `/route-loading` | Sibling `loading.tsx` convention around an async route. |
| `/route-error` | Sibling `error.tsx` route-level recovery. |
| `/error-demo` | An in-tree `ErrorBoundary` fallback that renders a recovery message. |
| `app/document.tsx` | App-owned `<html>`, `<head>`, and `<body>` document shell. |

The exact output can vary with the selected request mode. Payload JSON and
line-delimited stream frames are available through the CLI's documented
`?__ferrite_payload=server` and `?__ferrite_payload=stream` query modes.

## Known limitations

- Server actions are explicit form POSTs only. The production adapter can bind
  a process-local replay nonce to an app-owned session cookie and route, but
  this example does not establish an authenticated session. Automatic
  `"use server"` discovery, client event invocation, first-class auth,
  session-bound CSRF token issuance, and distributed replay coordination are
  not implemented.
- Client navigation, prefetch, hydration, and stream-frame behavior require
  the browser runtime and its generated assets; a one-shot CLI render does not
  prove physical browser behavior.
- The example uses placeholder metadata URLs such as `example.com`; replace
  them before treating the output as a deployable application.
- Hosted CI, public package/CLI distribution, and managed hosting are outside
  this fixture's proof boundary.
