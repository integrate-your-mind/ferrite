# Ferrite

Ferrite is a Rust-first experiment toward a React-like UI runtime and a Next.js-like application framework with a JavaScript and TypeScript authoring API.

Rust owns the framework boundaries that need strict validation: routing, render protocols, server-side rendering, production artifacts, and bounded serving. TypeScript owns application authoring and browser behavior.

## Experimental developer preview

Ferrite's source is published for technical evaluation, research, issue reporting, and focused contributions. It is not ready for unmanaged public production use, authenticated mutation-heavy workloads, or compatibility-sensitive deployments.

Expect breaking changes, incomplete packages, unsupported platforms, and revisions to public APIs. The npm packages and public CLI distribution are not yet available. A public repository does not mean that Ferrite has reached a supported public release.

Before contributing, read:

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [MIT license](LICENSE)

## Current model

Ferrite currently provides a buildable framework foundation with:

- a Rust virtual tree and escaped server-side HTML renderer;
- file-system routing for `app/page.tsx` applications, layouts, dynamic routes, catch-all routes, loading files, error files, and metadata;
- a Rust CLI with `init`, `routes`, `check`, `render`, `dev`, `build`, and `serve` workflows;
- TypeScript-aware page execution and browser bundling;
- a versioned Rust-owned protocol for render packets, streams, client references, server payloads, and server actions;
- server-first routes with whole-route hydration and imported client-component islands;
- a browser DOM runtime with mounting, hydration, events, state, effects, refs, memo helpers, transitions, error boundaries, and keyed reconciliation;
- payload-backed navigation, prefetching, stream-frame handling, history restoration, and managed document-head updates;
- explicit form-based server actions with origin checks and optional CSRF, replay, proxy, logging, and metrics controls;
- deterministic production artifacts with declared files, sizes, SHA-256 records, route metadata, browser bundles, prerenders, and action metadata;
- an artifact-only production server with bounded requests, worker admission, timeouts, overload rejection, cleanup, and generic public errors;
- native Node SSR bindings and a browser-consumable WASM protocol validator;
- local package, browser, nginx, container, failure-path, and recovery proof.

Ferrite is not a drop-in React or Next.js replacement. It does not yet provide a stable package install path, full React Server Components, automatic `"use server"` discovery, distributed replay state, general auth middleware, file uploads, complete tracing, broad platform proof, or a supported public HTTP edge.

## Requirements

The repository currently targets:

- Rust 1.85 or newer;
- Node.js 22 or newer;
- pnpm 11.7.0 through Corepack;
- a Chromium-family browser for the full browser proof;
- Docker for the nginx and container checks.

Some checks need platform tools that are not available on every workstation.

## Build from source

```sh
corepack enable
pnpm install --frozen-lockfile
cargo build --workspace
pnpm build
```

Run the normal repository gates:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

Run package verification when changing package or release files:

```sh
pnpm release:verify:npm
pnpm release:verify:cargo
```

## Exercise the included application

```sh
cargo run -p ferrite-cli -- check --project examples/basic
node examples/basic/render.mjs | cargo run -p ferrite-cli -- render --input -
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /posts/abc
cargo run -p ferrite-cli -- build --project examples/basic
cargo run -p ferrite-cli -- serve \
  --project examples/basic \
  --artifact .ferrite/build \
  --page-renderer packages/runtime/bin/render-artifact.mjs \
  --once \
  --request-path /posts/abc
```

A locally built or installed `ferrite` binary can initialize a small application:

```sh
ferrite init my-app
cd my-app
npm install
npm run check
npm run dev
```

Initialization refuses non-empty directories. Generated projects currently depend on locally built or staged Ferrite candidates because public registry distribution has not been proven.

## Production boundary

`ferrite build` creates the deployable artifact. `ferrite serve` validates that artifact before it binds a socket and serves only manifest-declared routes and files.

Ferrite's direct socket has a narrow one-request HTTP/1.1 upstream contract. It is intended to run behind a mature edge such as nginx, Envoy, or Caddy. Do not expose Ferrite as a general-purpose public HTTP server.

Use the deployment guide and checked templates for proxy, TLS, process supervision, smoke testing, logging, metrics, rollback, and failure handling:

- [Deployment guide](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Production-readiness review](docs/production-readiness-review-2026-07-10.md)

## Proof and limits

The repository records exact-source local proof for linting, type checks, builds, tests, browser flows, package candidates, artifact integrity, request framing, overload, timeouts, cleanup, and rollback behavior.

Hosted GitHub Actions has recently failed before job allocation, so local proof must not be represented as hosted CI proof. Registry publication, clean public installation, hosted deployment, long-duration production soak, and broad external platform evidence remain release gates.

## Contributions

Use a fork and open a pull request against `main`. Keep changes focused, add tests for changed behavior, document checks that were and were not run, and avoid adding broad framework surface without a concrete use case.

Security flaws must use the private process in [SECURITY.md](SECURITY.md), not a public issue.

## License

Ferrite is licensed under the [MIT License](LICENSE).
