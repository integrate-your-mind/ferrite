# Milestone 021 Proof

Date: 2026-06-29

## What Changed

- Expanded `@ferrite/runtime/server` metadata from `title` and `description` to include Open Graph, icons, and alternates.
- Added runtime validation for rich metadata fields, including Open Graph image dimensions, icon entries, canonical links, and language alternates.
- Added deterministic metadata merge behavior:
  - page/layout `title` and `description` override earlier values.
  - `openGraph` shallow-merges with later fields winning and later `images` replacing earlier images.
  - `icons` append from layouts to pages.
  - `alternates` shallow-merge with language maps merged by key.
- Added custom-document head rendering for `og:*` meta tags, icon links, canonical links, and language alternate links.
- Added typed Rust metadata structs in `ferrite-page-renderer` for the expanded metadata JSON contract.
- Added rich metadata head rendering in the Rust builder and dev-server fallback document paths.
- Added rich metadata to the example app so the app-owned document path is exercised by real TSX.
- Updated README and architecture docs for the new current boundary and next milestone queue.

## Why

Ferrite needs more than title and description to behave like a practical app framework. This milestone keeps the metadata surface intentionally narrow but useful: social previews, icons, canonical URLs, and language alternates now work through the same page/layout composition pipeline in runtime, dev, and production builds.

## Verified

```sh
pnpm --filter @ferrite/runtime test
cargo test --workspace
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Observed focused proof:

- Runtime tests passed: 51 tests.
- New runtime tests prove rich metadata merging, malformed rich metadata validation, and custom-document rich head tag serialization.
- Rust workspace tests passed after expanding `PageMetadata`.
- Page renderer tests prove rich metadata deserializes from the Node runner into Rust structs.
- Builder tests prove production wrapper HTML includes Open Graph, icon, canonical, and language alternate tags.
- Dev-server tests prove dev wrapper HTML includes the same rich metadata tags.
- Full workspace tests, lint, build, typecheck, render fixture, dev one-shot, and production example build passed.
- Production example build wrote 4 routes, 6 HTML files, 6 client bundles, and 0 skipped dynamic routes.
- Production home HTML includes `og:title`, `og:description`, `og:url`, `og:site_name`, `og:image`, icon, canonical, and language alternate tags.
- Dev one-shot HTML for `/` includes the same rich metadata tags inside the custom `app/document.tsx` shell.
- `ferrite-build.json` now serializes the rich `page_metadata` payload for the example routes.

## Not Proven Yet

- Metadata still does not support robots, viewport, Twitter cards, app links, verification tags, or structured JSON-LD.
- Open Graph support is intentionally small and does not infer defaults from `title` or `description`.
- Icon and alternate validation checks shape and types, not URL reachability.
- There is no coverage-reporting tool configured, so coverage was checked by targeted tests and full gates rather than a numeric coverage report.
