# Milestone 068 Proof: Server-Only Action Bootstrap Assets

## What Changed

- Added an optional `actionBootstrap` script URL to client bundle manifests.
- Added `ClientBundleOptions { action_bootstrap }` so Rust build/dev/serve orchestration can request a standalone action-form enhancer without turning a route into a hydrated client route.
- Updated `packages/runtime/bin/build-client.mjs` to emit a small browser entrypoint that calls `bootstrapServerActionForms(document)` for server-only action routes that have no route script and no client-reference script.
- Updated build and dev/production route rendering to inject and preload `actionBootstrap` scripts through the existing client bundle script helpers.
- Kept server-only routes' route-level `script` as `null`; the standalone enhancer is tracked separately.

## Normal Path Proof

- `cargo test -p ferrite-client-bundler real_runner_bootstraps_server_action_form_enhancement -- --nocapture`: passed.
- `cargo test -p ferrite-builder build_manifest_records_server_action_manifests -- --nocapture`: passed.
- `cargo test -p ferrite-dev-server injects_action_bootstrap_for_server_only_action_routes -- --nocapture`: passed.
- `cargo test -p ferrite-dev-server -- --nocapture`: passed on rerun after one isolated timing-sensitive worker-pool failure also passed when run by itself.

## Failure Path Proof

- Existing client bundler validation still rejects malformed client-reference output before returning a bundle.
- Existing build-time server-action manifest collection remains strict; production build fails if action-manifest collection fails.
- Request-time dev/serve action-bootstrap probing tolerates older or narrowly scoped renderer scripts that do not implement `--server-action-manifest`, so optional probing does not preempt ordinary non-action route rendering.

## Odd Path Proof

- A server route with a client-reference script and server-action bootstrap requested does not emit a duplicate standalone `actionBootstrap`; the client-reference chunk already installs `bootstrapServerActionForms(document)`.
- Fingerprinting rewrites `actionBootstrap` URLs and output paths the same way it rewrites route and client-reference scripts.
- Dev HTML includes the standalone action bootstrap while keeping the dev reload script and omitting a route hydration script.

## Not Proven

- Real browser-engine proof in Chromium, WebKit, or Firefox.
- Remote CI, push, or pull request proof from this checkout; no Git remote is configured locally.
- Automatic `"use server"` discovery.
- Deployment-stable inferred action ids.
- File upload support or streamed file parts.
- Client event actions.
