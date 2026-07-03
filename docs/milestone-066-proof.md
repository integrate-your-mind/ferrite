# Milestone 066 Proof: Explicit Server Action Manifests

## What Changed

- Added `collectServerActionsFromPageModule()` to `@ferrite/runtime/server`.
- Added `render-page.mjs --server-action-manifest` so Rust callers can render a route without invoking actions and collect explicit `createServerAction()` form references.
- Added `PageRenderer::collect_server_actions()` with protocol validation for each collected action reference.
- Added `server_action_manifests` to production `ferrite-build.json` and to the dev `/__ferrite/build` endpoint.
- Updated the CLI build summary to print the number of server-action manifests.

## Normal Path Proof

- The runtime manifest test first failed because `collectServerActionsFromPageModule()` was not exported.
- `node --test --test-name-pattern "server action manifest collection" packages/runtime/test/server-actions.test.mjs`: passed.
- The render-page manifest test first failed because `--server-action-manifest` was not a supported mode.
- `node --test --test-name-pattern "render-page emits registered server action manifest" packages/runtime/test/render-page.test.mjs`: passed.
- The page-renderer test first failed because `PageRenderer::collect_server_actions()` did not exist.
- `cargo test -p ferrite-page-renderer collects_server_action_manifest -- --nocapture`: passed.
- The builder test first failed because `BuildReport` had no `server_action_manifests` field.
- `cargo test -p ferrite-builder build_manifest_records_server_action_manifests -- --nocapture`: passed.
- `cargo test -p ferrite-dev-server serves_static_dynamic_and_manifest_routes -- --nocapture`: passed and proved `/__ferrite/build` includes explicit server-action references.

## Failure Path Proof

- The Rust page-renderer validates every collected action with `ferrite_protocol::validate_server_action_reference_payload()`, so malformed action reference packets fail before the manifest is accepted.
- The dev build manifest endpoint now returns a typed `PageRenderError` through `DevServerError::PageRender` when action manifest collection fails.

## Odd Path Proof

- Empty routes are omitted from `server_action_manifests`, so routes without server-action forms do not add empty manifest entries.
- Dynamic dev routes use representative params only for manifest collection. This proves shape and action identity for the route pattern, not a concrete user request.

## Not Proven

- Automatic `"use server"` export discovery.
- Deployment-stable inferred action ids.
- Persistent deployment action registries.
- Automatic client/app bootstrap wiring for action forms.
- Real browser-engine form submission proof.
- Upload streaming or file-part support.
- Client event actions.
- Remote CI, push, or pull request proof from this checkout.
