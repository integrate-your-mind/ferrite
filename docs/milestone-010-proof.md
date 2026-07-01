# Milestone 010 Proof

Date: 2026-06-29

## What Changed

- Added public `useEffect()` to `@ferrite/runtime`.
- Added effect support to the DOM hook dispatcher.
- Added post-commit effect flushing after successful mount, update, and hydration commits.
- Added dependency comparison with `Object.is`.
- Added cleanup before dependency-change reruns.
- Added cleanup when components are removed from the rendered tree.
- Added cleanup on root unmount.
- Added server-render no-op `useEffect` handling.
- Preserved failed update rollback so pending effects and cleanups do not run if the render fails before commit.

## Why

Applications need a controlled place for side effects and subscriptions. This milestone adds the minimal hook contract needed for cleanup-safe client behavior while keeping server rendering deterministic and side-effect free.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime test
```

Observed proof:

- Effects run after a successful mount commit.
- Effects do not rerun when dependency arrays are unchanged.
- Dependency changes run the previous cleanup before the next effect.
- Root unmount runs the active cleanup.
- Removing a component from the tree runs its cleanup.
- Failed updates do not run pending effects or cleanups.
- Server rendering accepts `useEffect` without running it.

The runtime tests prove:

- Mount, state update, explicit update, keyed reorder, incompatible replacement, failed update rollback, fragments, invalid mount, unmount, useState misuse, effect dependency cleanup, removed-component cleanup, failed-effect rollback, server no-op effects, hydration attachment, hydration tag mismatch, and hydration attribute mismatch.

## Not Proven Yet

- Effect execution is synchronous after commit; React-compatible deferred timing is not implemented.
- `useLayoutEffect`, `useMemo`, `useCallback`, `useRef`, transitions, Suspense, and priority scheduling are not implemented.
- Strict-mode style double invocation is not implemented.
- Async effect cancellation patterns are user-land for now.
