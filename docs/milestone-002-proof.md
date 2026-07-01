# Milestone 002 Proof

Date: 2026-06-29

## What Changed

- Added `@ferrite/runtime/dom` with `mount(child, container)`.
- Added a hook dispatcher so `useState` works while rendering mounted components.
- Added root handles with `update(nextChild)` and `unmount()`.
- Added direct DOM event handlers for props like `onClick`.
- Added attribute handling for strings, numbers, booleans, `className`, and `htmlFor`.
- Added Node-based DOM tests using `happy-dom`.

## Why

The project needs a browser runtime, not just Rust SSR. This milestone proves that the JavaScript-facing API can mount Ferrite component trees into a DOM, dispatch events, and preserve state across updates.

The implementation intentionally uses full rerendering per state update. That is simple and testable for this milestone; keyed reconciliation is still a future milestone.

## Verified

```sh
pnpm --filter @ferrite/runtime test
```

The DOM test suite proves:

- Function components mount into a real DOM-like document.
- `useState` supports lazy initializers.
- `onClick` dispatch updates state with a functional updater.
- State persists across rerenders.
- Root `update()` replaces props and children.
- Fragments and arrays do not create wrapper nodes.
- Invalid event handlers fail before partial UI is mounted.
- `unmount()` clears the DOM and rejects future updates.
- `useState` outside render fails clearly.

## Not Proven Yet

- Hydration over server-rendered markup.
- Keyed reconciliation.
- Batched updates.
- Effect hooks and cleanup.
- Event delegation or synthetic events.
- Browser-run test in an actual browser engine.
- Dev server integration.
- Production bundling.

