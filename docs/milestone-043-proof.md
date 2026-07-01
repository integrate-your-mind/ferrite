# Milestone 043 Proof: Head Reconciliation For Payload Navigation

## Changed

- Added document-shaped payload head extraction during server-payload navigation.
- Added managed head reconciliation for `title`, `meta`, `link`, `script`, and `style` nodes.
- Marked inserted framework-managed head nodes with `data-ferrite-head="managed"`.
- Replaced stale framework-managed title/meta/link/script resources while preserving unrelated head nodes.
- Preserved repeated metadata nodes such as multiple Open Graph images.
- Added prevalidation so malformed head payloads fail before route DOM, head DOM, or history state mutates.

## Why

Milestone 042 could update the route root during payload navigation, but document-shaped payloads also carry title, metadata, styles, and scripts. Without reconciling those resources, navigation could leave stale metadata or fail to install route-specific client-reference resources.

## Proof

- `pnpm --filter @ferrite/runtime test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

Focused coverage includes:

- Navigation updates `document.title`.
- Navigation replaces managed description and Open Graph metadata.
- Navigation preserves unrelated user or third-party head nodes such as viewport, preconnect, and analytics scripts.
- Navigation removes stale Ferrite route stylesheet/script resources and installs new ones.
- Navigation preserves repeated Open Graph image metadata from the payload.
- Malformed head props reject before route DOM, head DOM, or history changes.

## Not Proven

- Popstate restoration is not implemented.
- Prefetching is not implemented.
- Payload application remains full-response only, not incremental network streaming.
- The payload format is not Flight-compatible.
