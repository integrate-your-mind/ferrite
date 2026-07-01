# Milestone 050 Plan: Immutable Production Asset Fingerprints

## Goal

Give generated production client assets content-addressed filenames and immutable cache headers so route HTML can safely reference long-lived browser assets.

## Scope

- Add content hashes to production-emitted client asset filenames.
- Preserve stable references from HTML, manifests, and client-reference chunks to the hashed paths.
- Serve hashed assets with immutable long-lived cache headers.
- Keep non-hashed or unknown assets on conservative revalidation caching.
- Ensure rebuilds remove stale production assets that are no longer referenced.
- Add tests for route scripts, client-reference chunks, CSS/assets, and stale cleanup.

## Out Of Scope

- CDN deployment integration.
- Asset manifest signing.
- Runtime preloading strategy.
- Server actions.
- Flight wire-format compatibility.

## Required Proof

- Focused build/dev-server tests for hashed asset names and cache headers.
- Rebuild cleanup test proving stale hashed assets are removed.
- Existing client-reference and server-only cleanup tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
