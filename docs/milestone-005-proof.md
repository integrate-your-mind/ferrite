# Milestone 005 Proof

Date: 2026-06-29

## What Changed

- Added `ferrite-builder`, a Rust crate for production build output.
- Added `ferrite build` to the CLI.
- Added static route-shell HTML output under `.ferrite/build`.
- Added `ferrite-build.json` with route, HTML file, and skipped dynamic route metadata.
- Added `ferrite-client.js` as a production client placeholder.
- Added generated route types during build.
- Added `pnpm build:example`.

## Why

The project needs a production output path. This milestone does not yet bundle or execute TSX page modules, but it proves the Rust toolchain can turn an app directory into deterministic build artifacts, static HTML for known static routes, and explicit reporting for dynamic routes that cannot yet be statically generated.

## CLI Contract

```sh
ferrite build --project examples/basic
ferrite build --project examples/basic --out .ferrite/build
ferrite --json build --project examples/basic
```

## Verified

```sh
cargo test -p ferrite-builder
cargo run -p ferrite-cli -- build --project examples/basic
cargo run -p ferrite-cli -- --json build --project examples/basic
sed -n '1,220p' examples/basic/.ferrite/build/index.html
sed -n '1,260p' examples/basic/.ferrite/build/ferrite-build.json
```

The builder tests prove:

- Static routes write `index.html` files.
- Nested static routes write nested `index.html` files.
- Build manifests are written.
- Generated route types are written.
- Dynamic routes are skipped until params are known.
- Missing app directories fail through the router error path.
- HTML route metadata is escaped.

The example build wrote:

- `examples/basic/.ferrite/build/index.html`
- `examples/basic/.ferrite/build/ferrite-build.json`
- `examples/basic/.ferrite/build/ferrite-client.js`

It reported `/posts/:id` as a skipped dynamic route.

## Not Proven Yet

- Executing TSX page modules during build.
- JavaScript/TypeScript bundling.
- Source maps.
- CSS handling.
- Asset copying.
- Dynamic parameter generation.
- Serving the production output through a static file server.

