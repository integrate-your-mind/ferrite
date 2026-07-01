# Milestone 003 Proof

Date: 2026-06-29

## What Changed

- Added `hydrate(child, container)` to `@ferrite/runtime/dom`.
- Added hydration tree walking for primitives, arrays, fragments, host elements, and function components.
- Added hydration-time hook initialization so event handlers can update state after hydration.
- Added attribute verification for hydrated elements.
- Added mismatch errors for tag, attribute, text, missing node, and extra node cases.
- Added adjacent-text support because parsed HTML can merge separate VNode text children into one DOM text node.

## Why

Ferrite needs a real browser path from server-rendered markup to interactive UI. This milestone proves that existing HTML can be reused, event handlers can attach without replacing the initial node, and later state updates can take over.

## Verified

```sh
pnpm --filter @ferrite/runtime test
```

The hydration tests prove:

- Matching server DOM is not replaced during hydration.
- `onClick` attaches to hydrated DOM.
- `useState` lazy initialization runs during hydration.
- A hydrated event can update state and rerender the DOM.
- Tag mismatches fail clearly and leave existing DOM unchanged.
- Attribute mismatches fail clearly.
- Adjacent text children hydrate against a single parsed browser text node.

## Not Proven Yet

- Hydration in a real browser engine rather than `happy-dom`.
- Incremental hydration.
- Streaming hydration.
- Suspense or async boundaries.
- Keyed reconciliation.
- Effect hooks and cleanup.
- Dev server integration.
- Production bundling.

