# Milestone 067 Proof: Client Entrypoint Server Action Bootstrap

## What Changed

- Added `bootstrapServerActionForms()` to `@ferrite/runtime/dom`.
- The bootstrap helper installs `enhanceServerActionForms()` once per event root and removes its registry entry when destroyed.
- Updated generated route client bundles to call `bootstrapServerActionForms(document)` after hydration.
- Updated generated client-reference bundles to call the same bootstrap before hydrating marked islands.

## Normal Path Proof

- The runtime bootstrap test first failed because `@ferrite/runtime/dom` did not export `bootstrapServerActionForms()`.
- `pnpm --filter @ferrite/runtime build && node --test --test-name-pattern "server action form bootstrap" packages/runtime/test/dom.test.mjs`: passed.
- The real client-bundler bootstrap test first failed because generated route bundles did not contain a server-action form bootstrap call.
- `cargo test -p ferrite-client-bundler real_runner_bootstraps_server_action_form_enhancement -- --nocapture`: passed.

## Failure Path Proof

- The bootstrap helper reuses the existing `enhanceServerActionForms()` validation, so missing `document`, missing event roots, or missing `fetch` still fail through the established enhancer checks.
- The idempotence test proves repeated generated entrypoint calls on the same document do not double-submit a server-action form.

## Odd Path Proof

- Destroying the returned bootstrap handle removes the delegated listener and clears the per-root bootstrap registry entry.
- Client-reference chunks and full route client bundles use the same document-level bootstrap, so forms outside an individual island/root can still be intercepted once browser JavaScript is present.

## Not Proven

- Dedicated browser bootstrap assets for server-only routes that contain server-action forms but no `"use client"` route bundle or client-reference chunk.
- Real browser-engine proof in Chromium, WebKit, or Firefox; the idempotence proof uses `happy-dom`.
- Automatic `"use server"` discovery.
- Deployment-stable inferred action ids.
- Upload streaming or file-part support.
- Client event actions.
- Remote CI, push, or pull request proof from this checkout.
