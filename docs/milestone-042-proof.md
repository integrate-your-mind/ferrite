# Milestone 042 Proof: Server Payload Navigation Integration

## Changed

- Added `createServerPayloadNavigator()` in `@ferrite/runtime/dom`.
- Added a navigator API that owns a mounted root and exposes programmatic `navigate()`.
- Added safe same-origin link interception for plain left-click anchors.
- Added bypass behavior for external links, download links, non-`_self` targets, and modifier-key clicks.
- Added fallback behavior for failed intercepted payload requests.
- Added `pushState`/`replaceState` history updates after successful payload navigation.
- Added route-root extraction for document-shaped payloads with `#ferrite-root` or `#ferrite-dev-root`.

## Why

Milestone 041 could fetch and apply server payloads, but applications still had to call those helpers manually. This milestone adds a small browser navigation layer that can use the server-payload HTTP surface for same-origin route transitions while preserving normal browser navigation when interception is unsafe or payload loading fails.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Programmatic same-origin navigation fetches a server-payload response and updates browser history.
- Document-shaped payloads apply only the route root instead of inserting `<html>` into the app container.
- Deferred chunks replace matching Suspense shell boundaries during navigation.
- Same-origin plain left-click links are intercepted and applied through payload navigation.
- Failed intercepted payload requests call the fallback path and leave DOM/history unchanged.
- Malformed payloads reject and leave DOM/history unchanged.
- External, download, non-`_self` target, and modifier-key links bypass payload interception.

## Not Proven

- Document head/title/meta/link/script reconciliation is not implemented.
- Popstate restoration is not implemented.
- Prefetching is not implemented.
- Payload application remains full-response only, not incremental network streaming.
- The payload format is not Flight-compatible.
