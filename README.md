# Ferrite

Ferrite is a Rust-first experiment toward a React-like UI runtime and a Next.js-like application framework with a JavaScript and TypeScript authoring API.

Rust owns the boundaries that need strict validation: module graphs, routing, render protocols, server-side rendering, production artifacts, request handling, and bounded serving. TypeScript owns application authoring and browser behavior.

## Experimental developer preview

Ferrite's source is published for technical evaluation, research, issue reporting, and focused contributions. It is not ready for unmanaged public production use, authenticated mutation-heavy workloads, or compatibility-sensitive deployments.

Expect breaking changes, incomplete packages, unsupported platforms, and revisions to public APIs. Ferrite's first registry boundary is limited to the portable protocol, protocol-WASM, and runtime prerelease packages; the public CLI and native package set are not distributed by that release. Until a GitHub release links verified registry versions, use the source-backed workflow below.

Before contributing, read:

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [MIT license](LICENSE)
- Source-build examples ranging from a minimal route to a product-shaped docs workbench and the broader framework feature fixture.

## Examples

- [`examples/hello-world-demo`](examples/hello-world-demo/README.md) is the smallest source-checkout path: one TypeScript route, `ferrite check`, a production artifact, and artifact-only serving.
- [`examples/docs-workbench`](examples/docs-workbench/README.md) is a product-shaped server-first documentation app with a custom document, layouts, generated dynamic and catch-all route types, metadata, prerendered paths, and one isolated client navigation island.
- [`examples/basic`](examples/basic/README.md) remains the advanced framework fixture for full-route hydration, imported client islands, server actions, streaming, route loading/error conventions, and error boundaries.

Run the dedicated gates from the repository root:

```sh
pnpm check:demos
pnpm build:demos
pnpm test:demos
```

`test:demos` builds real artifacts, validates every declared file hash and route,
starts the actual `ferrite serve` adapter, exercises normal, query, deep-route,
and 404 requests, drives the hydrated Docs Workbench in Chrome, and proves a
tampered artifact is rejected before the server binds. The examples still
require a source checkout; registry installation and hosted deployment are not part
of this proof.

## Current model

Ferrite currently provides a buildable framework foundation with:

- a Rust virtual tree and escaped server-side HTML renderer;
- a compiler-owned TypeScript module graph with deterministic traversal, cycle diagnostics, dependency snapshots, and development invalidation;
- file-system routing for `app/page.tsx` applications, layouts, dynamic routes, catch-all routes, loading files, error files, and metadata;
- a Rust CLI with `init`, `routes`, `check`, `render`, `dev`, `build`, and `serve` workflows;
- TypeScript-aware page execution and browser bundling with guarded project/package resolution;
- a versioned Rust-owned protocol for render packets, streams, client references, server payloads, and server actions;
- server-first routes with whole-route hydration and imported client-component islands;
- a browser DOM runtime with mounting, hydration, events, state, effects, refs, memo helpers, transitions, error boundaries, and keyed reconciliation;
- bounded payload navigation, prefetching, stream-frame handling, history restoration, stale-navigation ownership, and managed document-head updates;
- explicit form-based server actions with origin checks and optional CSRF, replay, proxy, logging, and metrics controls;
- deterministic production artifacts with declared files, sizes, SHA-256 records, route metadata, browser bundles, prerenders, and action metadata;
- an artifact-only production server with bounded requests, worker admission, timeouts, overload rejection, cleanup, signal-driven drain, and generic public errors;
- native Node SSR bindings with checksum verification and fail-closed macOS copy signing, plus a browser-consumable WASM protocol validator;
- real example applications, a source-backed project website, and local package, browser, nginx, container, failure-path, and recovery proof.

Ferrite is not a drop-in React or Next.js replacement. It does not yet provide a stable registry install path, full React Server Components, automatic `"use server"` discovery, distributed replay state, general auth middleware, file uploads, complete tracing, broad platform proof, or a supported public HTTP edge.

## Requirements

The repository currently targets:

- Git and network access to the Cargo and npm registries;
- rustup with Rust 1.95, as declared by `rust-toolchain.toml`; the Cargo crates retain Rust 1.85 as their minimum supported compiler version;
- a native compiler and linker supported by Rust on the host platform;
- Node.js 22 or newer, with Node 24 selected by `.node-version`;
- pnpm 11.7.0 through Corepack;
- a Chromium-family browser for the full browser proof;
- Docker for the nginx and container checks;
- Buildkite Agent for the dedicated local CI lane.

Some Node distributions do not bundle Corepack; install Corepack before running `corepack enable` in that case. Docker, Chromium, and Buildkite Agent are required only for their matching proof gates.

## Build from source

Run these commands from the repository root:

```sh
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
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

The verified npm tarballs are retained under
`dist/npm-packages/tarballs/` with their identities in
`dist/npm-packages/npm-package-report.json`. See the
[npm release runbook](docs/npm-release.md) for the prerelease package boundary,
approval, provenance, publication, and rollback gates.

For the browser gate, install the matching browser and expose its executable:

```sh
pnpm exec playwright-core install chromium
export FERRITE_BROWSER_EXECUTABLE="$(node --input-type=module -e 'import { chromium } from "playwright-core"; process.stdout.write(chromium.executablePath())')"
pnpm test:browser
```

## Create a source-backed starter

The portable npm prerelease does not provide the Rust CLI or a registry-only
application starter. The repository now verifies a local macOS arm64 CLI
package candidate, but the source-backed path remains the supported entry
point. From a clean Ferrite source checkout, create a working local starter
with:

```sh
pnpm starter:create -- ../my-ferrite-app
cd ../my-ferrite-app
npm run dev
```

`starter:create` builds the candidate CLI and release-shaped packages, verifies package metadata, initializes a private sibling staging directory, vendors the protocol/runtime tarballs and CLI under the ignored `.ferrite-source/` directory, installs from those local artifacts, and runs `npm run check`. The target's parent must already exist and the target itself must be absent. Ferrite publishes with an operating-system no-replace rename and never recursively cleans the user target.

Exercise the production path:

```sh
npm run build
npm run start -- --once --request-path /
```

The generated app is tied to the source checkout and host platform that created `.ferrite-source/`. Recreate it from source on another machine. This workflow is for developer-preview evaluation; it is not a substitute for registry packages or a supported CLI release. See [Source onboarding](docs/source-onboarding.md) for the exact boundary and troubleshooting steps.

To build two release-shaped CLI tarball candidates and exercise the real
packaged binary from an offline, empty npm consumer on macOS arm64:

```sh
pnpm release:verify:cli
```

This verifies the `@ferrite/cli` launcher, the
`@ferrite/cli-darwin-arm64` binary package, exact starter dependency versions,
existing-target refusal, and tamper rejection. It does not publish either
package, prove npm ownership, install the generated application's dependencies
offline, or support another host. See
[CLI distribution candidate](docs/cli-distribution.md).

## Exercise the included applications

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

The example also includes source-backed tic-tac-toe routes used by the project website. Their screenshots and capture receipts live under `website/public/demos/`.

A locally built `ferrite` binary can initialize the registry-shaped project skeleton for generator development and inspection:

```sh
ferrite init my-app
```

Initialization accepts an absent or verified empty target; it rejects files,
non-empty directories, the current working directory, and symbolic links
without writing through them. Ferrite stages the complete skeleton in a
private sibling and publishes it with an operating-system no-replace rename.
A direct source-built binary still emits the source-mode package versions; the
verified npm wrapper instead pins matching `@ferrite/runtime` and
`@ferrite/cli` prerelease versions. Both manifests reference unpublished
Ferrite packages, so a plain `npm install` still returns a registry `404`. Do
not use the raw skeleton as an onboarding path. Use `pnpm starter:create` above
until registry publication and public CLI installation are separately
authorized and verified.

## Project website

The source-backed website and its real demo assets live in `website/`:

```sh
pnpm --dir website install --ignore-workspace --frozen-lockfile
pnpm --dir website check
pnpm --dir website build
pnpm --dir website start
```

Run `pnpm --dir website lint` and `pnpm --dir website test` before changing public claims or demo assets. The repository does not claim a hosted deployment unless a current deployment receipt exists.

## Production boundary

`ferrite build` creates the deployable artifact. `ferrite serve` validates that artifact before it binds a socket and serves only manifest-declared routes and files.

Ferrite's dev and production sockets share a narrow one-request HTTP/1.1 upstream contract. They require exact CRLF framing, an origin-form target, one valid `Host`, no request `Transfer-Encoding` or `Expect`, and positive request bodies only for the action endpoint with one decimal `Content-Length`. Ambiguous framing, malformed authorities, unsupported targets, and pipelined suffixes fail closed. Every response closes the connection.

Run the pinned nginx compatibility proof on a clean exact commit when Docker is available:

```sh
pnpm test:nginx:stack
```

Production deployments should put Ferrite behind a mature edge such as nginx, Envoy, or Caddy. Do not expose it as a general-purpose public HTTP server. Use the checked deployment material for proxy headers, TLS, process supervision, smoke testing, logging, metrics, rollback, and failure handling:

- [Deployment guide](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Production-readiness review](docs/production-readiness-review-2026-07-10.md)

## Proof and limits

The repository records exact-source local proof for linting, type checks, builds, tests, browser flows, source-backed starter creation, package candidates, module-graph invalidation, artifact integrity, request framing, overload, timeouts, cleanup, and rollback behavior.

The active CI definition is a [dedicated local Buildkite agent lane](docs/buildkite-local-ci.md). It preserves the build, lint, test, package, coverage, current-host native, and Docker-backed nginx gate categories that this macOS arm64 machine can execute without GitHub-hosted runners. It does not preserve the removed Linux verification or five-platform native artifact matrix. The lane is trusted local-machine execution: it is not GitHub-hosted CI, independent review, cross-platform evidence, or merge-readiness proof. Registry publication, registry-backed clean installation, hosted deployment, long-duration production soak, and broad external platform evidence remain release gates.

## Contributions

Use a fork and open a pull request against `main`. Keep changes focused, add tests for changed behavior, document checks that were and were not run, and avoid adding broad framework surface without a concrete use case.

Security flaws must use the private process in [SECURITY.md](SECURITY.md), not a public issue.

## License

Ferrite is licensed under the [MIT License](LICENSE).
