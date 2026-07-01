# Milestone 013 Proof

Date: 2026-06-29

## What Changed

- Added public `startTransition()`, `useTransition()`, and `useDeferredValue()` to `@ferrite/runtime`.
- Added an internal transition-scope flag so state setters can distinguish urgent work from transition work outside render.
- Added a DOM root transition queue that batches transition state updates into a microtask commit.
- Added `useTransition` pending state that renders immediately when a transition starts and clears when queued work flushes.
- Added `useDeferredValue` so derived render values can lag behind urgent state until the transition flush.
- Added server dispatcher support for transition hooks without scheduling client work.
- Added unmount cancellation for queued transition updates.

## Why

React-style applications need a way to mark non-urgent work so urgent UI updates can remain responsive. This milestone adds the first real scheduling surface without pretending to be a full concurrent renderer or priority scheduler.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime test
```

Observed proof:

- `startTransition` defers state updates until a later microtask.
- `useTransition` exposes `pending: true` before deferred state commits, then clears after the flush.
- Urgent state updates commit before transition state updates.
- `useDeferredValue` keeps the old value during the urgent render and catches up after the transition flush.
- Server rendering accepts transition hooks without scheduling.
- `startTransition` rejects non-functions.
- Queued transition updates are ignored after unmount.
- Thrown transition scopes reset transition mode so later normal state updates remain synchronous.

The runtime tests prove:

- Mount, state update, explicit update, keyed reorder, incompatible replacement, failed update rollback, fragments, invalid mount, unmount, hook misuse, effect cleanup, refs, memo/callback identity, server hooks, transition deferral, pending state, urgent-before-transition ordering, deferred values, transition edge cases, and hydration mismatch behavior.

## Not Proven Yet

- This is a microtask transition queue, not a priority scheduler.
- Rendering is not interruptible once a commit starts.
- Transition errors are not routed through error boundaries.
- Suspense, `use`, async server components, and streaming are not implemented.
