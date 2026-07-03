# Milestone 080: Opt-In Server Action CSRF Token

Date: 2026-07-03

## What Changed

- Added an optional server-action CSRF token render option that emits a hidden `__ferrite_csrf` field in server-rendered action forms.
- Added dev and production Rust server configuration for an expected server-action CSRF token; production CLI users can load it with `--server-action-csrf-token-env`.
- Hardened action POST parsing so configured deployments reject missing, duplicated, or mismatched CSRF token fields before invoking app code.
- Kept the CSRF metadata field out of the validated action request form passed to app server actions.

## Proof

- `pnpm --filter @ferrite/runtime test -- server-actions`: passed.
- `cargo test -p ferrite-page-renderer passes_server_action_csrf_token_to_page_render_options`: passed.
- `cargo test -p ferrite-dev-server action_`: passed.
- `cargo test -p ferrite-cli csrf`: passed.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- This is an opt-in static token guard, not full session-bound CSRF protection.
- Ferrite still needs token rotation guidance, per-session binding, replay protection, trusted-proxy configuration, cookie/SameSite guidance, and auth integration documentation.
- Remote CI is still unproven because this checkout has no configured Git remote.
