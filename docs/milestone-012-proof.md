# Milestone 012 Proof

Date: 2026-06-29

## What Changed

- Added public `useRef()`, `useMemo()`, and `useCallback()` to `@ferrite/runtime`.
- Added DOM dispatcher implementations for refs and memoized values.
- Added server dispatcher implementations for refs and memoized values.
- Added explicit hook-state tags for effects and memo records.
- Changed effect cleanup traversal to only run tagged effect cleanup records.

## Why

React-style apps rely on stable mutable refs and memoized values/callbacks for ergonomic component code. The effect-state tagging also closes a correctness gap where generic hook slots could be misread during cleanup.

## Verified

```sh
pnpm --filter @ferrite/runtime typecheck
pnpm --filter @ferrite/runtime test
```

Observed proof:

- `useRef` preserves the same mutable object across renders.
- `useMemo` avoids recomputation while dependencies are unchanged.
- `useCallback` preserves callback identity while dependencies are unchanged and changes identity when dependencies change.
- Server rendering accepts `useRef` and `useMemo`.

The runtime tests prove:

- Mount, state update, explicit update, keyed reorder, incompatible replacement, failed update rollback, fragments, invalid mount, unmount, useState misuse, effect dependency cleanup, removed-component cleanup, failed-effect rollback, server no-op effects, refs, memo/callback identity, server ref/memo, hydration attachment, hydration tag mismatch, and hydration attribute mismatch.

## Not Proven Yet

- `useReducer`, `useId`, `useSyncExternalStore`, `useDeferredValue`, `useTransition`, and `useLayoutEffect` are not implemented.
- Memo cache eviction and concurrent render semantics are not implemented.
- Hook identity is still scoped to the current component path model, not a full fiber tree.
