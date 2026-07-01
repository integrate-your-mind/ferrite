# Milestone 014 Proof

Date: 2026-06-29

## What Changed

- Added public `useLayoutEffect()` to `@ferrite/runtime`.
- Added server dispatcher no-op behavior for `useLayoutEffect`.
- Split DOM pending effects into layout and passive queues.
- Changed commit flushing so layout effects run before passive effects regardless of declaration order.
- Changed cleanup ordering so layout cleanups run before passive cleanups on dependency changes, removal, and unmount.

## Why

Layout effects are the synchronous post-commit hook used for DOM reads/writes before passive effects. The runtime already had passive effect cleanup, but it needed a distinct phase to avoid incorrect ordering for components that use both effect types.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime test
```

Observed proof:

- `useLayoutEffect` throws clearly outside render.
- Layout effects run before passive effects even when `useEffect` is declared first.
- On dependency changes, the previous layout cleanup runs before the next layout effect, and passive cleanup/effect happen after that.
- On unmount, layout cleanup runs before passive cleanup.
- Server rendering accepts `useLayoutEffect` without running it.

The runtime tests prove:

- Mount, state update, explicit update, keyed reorder, incompatible replacement, failed update rollback, fragments, invalid mount, unmount, hook misuse, passive effects, layout effect ordering/cleanup, refs, memo/callback identity, server hooks, transition deferral, pending state, urgent-before-transition ordering, deferred values, transition edge cases, and hydration mismatch behavior.

## Not Proven Yet

- Layout effects are synchronous after commit, but there is still no browser paint boundary modeling.
- Error boundaries and transition error routing are not implemented.
- Strict-mode double invocation is not implemented.
- Rendering is not interruptible once a commit starts.
