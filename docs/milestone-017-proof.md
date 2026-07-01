# Milestone 017 Proof

Date: 2026-06-29

## What Changed

- Added production duplicate static output detection in `ferrite-builder`.
- Added a `DuplicateStaticOutput` build error that reports the concrete route path that would be overwritten.
- Added regression tests for duplicate normal dynamic params, duplicate optional catch-all empty outputs, and cross-route collisions.
- Updated README and architecture docs to remove duplicate static output detection from the known gaps.

## Why

Catch-all and optional catch-all static params can produce the same concrete output path from different param entries or even different route files. Without an explicit guard, the later page silently overwrites the earlier HTML and manifest state becomes misleading. The builder now fails before rendering or bundling the duplicate path.

## Verified

```sh
cargo fmt --all
cargo test -p ferrite-builder
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Observed proof:

- Focused builder tests passed: 15 tests.
- Duplicate dynamic static params now fail for `/posts/alpha`.
- Optional catch-all `{}` and `{ slug: [] }` now fail as duplicate `/docs`.
- Cross-route collisions between `/docs/:id` and `/docs/*slug` now fail for `/docs/api`.
- Existing static, dynamic, catch-all, optional catch-all, metadata, render-failure, and bundler-failure builder tests still pass.

## Not Proven Yet

- The duplicate error reports the concrete route path, not every route/param entry involved in the collision.
- Build manifest output remains all-or-nothing for the current process, but no transactional cleanup is implemented for files written before a later duplicate is found.
