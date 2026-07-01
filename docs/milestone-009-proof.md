# Milestone 009 Proof

Date: 2026-06-29

## What Changed

- Replaced root update `replaceChildren()` rerenders with off-DOM rendering followed by live DOM patching.
- Added in-place text node updates for compatible text nodes.
- Added in-place element patching for compatible element tags.
- Added attribute synchronization, including removal of stale attributes.
- Added event-handler synchronization, including replacement and removal of stale handlers.
- Added keyed child matching for keyed element children so reorders preserve existing DOM nodes.
- Added component hook paths that account for component keys within a parent path.

## Why

The browser runtime needs to preserve DOM identity across common updates. Full rerenders lose focus, selection, scroll-adjacent state, and third-party DOM attachment points. This milestone adds a small, testable reconciliation layer without introducing a fiber scheduler yet.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime test
```

Observed proof:

- State updates keep the original `<button>` node while updating text and attributes.
- `root.update()` keeps a compatible `<div>` node while changing class, boolean attributes, and children.
- Event updates replace an old click handler with a new handler and remove stale handlers.
- Keyed `<li>` children reorder from `a,b,c` to `c,a` while preserving the original `c` and `a` nodes and removing `b`.
- Incompatible node types replace the old node.
- Failed updates from invalid event handlers throw before mutating the live DOM.

The runtime tests prove:

- Mount, state update, explicit update, keyed reorder, incompatible replacement, failed update rollback, fragments, invalid mount, unmount, useState misuse, hydration attachment, hydration tag mismatch, and hydration attribute mismatch.

## Not Proven Yet

- This is not a fiber scheduler.
- Effects and cleanup hooks are not implemented.
- Keyed component state identity is only scoped by parent path and key; it is not yet a complete React-compatible identity model.
- Fragment-level keys are not modeled.
- Async rendering, Suspense, transitions, and priority scheduling are not implemented.
