# Milestone 020 Proof

Date: 2026-06-29

## What Changed

- Added a small priority scheduler to `@ferrite/runtime` with `sync` and `transition` lanes.
- Added unstable scheduler utilities for task scheduling, cooperative render yielding, yield interval tuning, and deterministic test budgets.
- Moved transition updates from microtask flushing to scheduled transition tasks.
- Added cooperative yield checks before DOM render work so transition renders can restart before mutating the live DOM.
- Added transition render snapshots for hook state and error boundary state so yielded attempts do not leak partial render state.
- Kept urgent updates synchronous so they can commit before queued transition work.
- Updated runtime tests from microtask assumptions to scheduler-task assertions.
- Updated README and architecture docs to move priority scheduling out of the future-work list.

## Why

Ferrite needed a real scheduling boundary after adding transitions and error boundaries. The new scheduler still keeps the runtime simple, but it gives transition work a lower-priority lane, lets urgent updates commit first, and gives transition renders a cooperative yield point before patching the real DOM.

## Verified

```sh
pnpm --filter @ferrite/runtime test
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Observed proof from the focused runtime gate:

- Runtime tests passed: 48 tests.
- New tests prove sync scheduler callbacks run before transition callbacks.
- New tests prove a transition render can yield without committing partial DOM, then retry and commit after the budget is released.
- Existing transition tests now prove deferred state updates use scheduled work instead of microtasks.
- Existing urgent-update tests still prove urgent state commits before transition state.
- Existing error boundary transition tests still pass through scheduled transition work.
- Invalid scheduler render budgets are rejected.

## Not Proven Yet

- The renderer restarts yielded transition renders; it does not resume a partially completed Fiber-like tree.
- Cooperative yielding only happens before DOM patching. The DOM commit phase is still synchronous.
- Only `sync` and `transition` lanes exist; idle work and richer priority classes are not implemented.
- There is no coverage-reporting tool configured, so coverage was checked by targeted tests and full gates rather than a numeric coverage report.
