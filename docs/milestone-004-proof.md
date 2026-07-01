# Milestone 004 Proof

Date: 2026-06-29

## What Changed

- Added `ferrite-dev-server`, a Rust crate for development route serving.
- Added `ferrite dev` to the CLI.
- Added `ferrite dev --once --request-path <path>` for scriptable checks.
- Added route matching for static, dynamic, catch-all, and optional catch-all route patterns.
- Added `GET /__ferrite/routes` and `GET /__ferrite/build` manifest endpoints.
- Added a tiny `/__ferrite/client.js` polling client that reloads when the build id changes.
- Added source fingerprinting so route changes under `app/` regenerate route types and advance the build id.
- Added an actual TCP listener proof for one HTTP request.

## Why

The project needs a Next-style development loop. This milestone does not execute TSX page modules yet, but it proves the Rust server can discover the app tree, serve app route URLs, regenerate route types, expose live route/build state, and respond to changed app files without a process restart.

## CLI Contract

```sh
ferrite dev --project examples/basic --host 127.0.0.1 --port 3000
ferrite dev --project examples/basic --once --request-path /posts/abc
ferrite --json dev --project examples/basic --once --request-path /__ferrite/build
```

## Verified

```sh
cargo test -p ferrite-dev-server
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /
cargo run -p ferrite-cli -- dev --project examples/basic --once --request-path /posts/abc
cargo run -p ferrite-cli -- --json dev --project examples/basic --once --request-path /__ferrite/build
```

The dev-server tests prove:

- Static routes are served.
- Dynamic routes are served and params are surfaced.
- Route manifests are exposed as JSON.
- Unknown routes return 404.
- Invalid request paths fail clearly.
- Catch-all routes match.
- The polling client script is served.
- Adding a new route file advances the build id and makes the route available without restarting.
- A real TCP listener can serve one HTTP request.

## Not Proven Yet

- Executing TSX page modules inside the dev server.
- Browser module bundling.
- Hot module replacement; current client does full-page reload polling.
- Static prerendering.
- Production output.
- Source maps.
- Running the persistent server under browser automation.

