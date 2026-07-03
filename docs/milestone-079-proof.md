# Milestone 079: Server Action Host Requirement

Date: 2026-07-03

## What Changed

- Hardened server-action request parsing so `POST /_ferrite/action` requires a valid `Host` header before parsing action form fields.
- Kept same-host `Origin` and `Referer` checks intact, but removed the previous path where missing `Host` skipped those checks.
- Updated focused dev-server tests so normal action requests include `Host`, and added explicit missing-host rejection coverage.

## Proof

- `cargo test -p ferrite-dev-server action_`: passed.
- `cargo fmt --all -- --check`: passed.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- This is a fail-closed origin-check prerequisite, not full CSRF/session/replay protection.
- Ferrite still needs CSRF token/session binding, replay guidance, trusted-proxy configuration, cookie guidance, and deployment-stable inferred action IDs.
- Remote CI is still unproven because this checkout has no configured Git remote.
