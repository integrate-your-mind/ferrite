# Milestone 086: Production Server-Action CSRF Cookie Binding

Date: 2026-07-03

## What Changed

- Added optional production server-action CSRF cookie binding.
- Added `ProductionServerConfig::with_server_action_csrf_cookie_name()`.
- Added `ferrite serve --server-action-csrf-cookie-name <name>`.
- The CLI requires `--server-action-csrf-token-env` when cookie binding is enabled.
- The CLI rejects invalid cookie names and non-cookie-safe CSRF token values for this mode.
- Production route responses can emit `Set-Cookie: <name>=<token>; Path=/; SameSite=Lax; HttpOnly; Secure`.
- Action POSTs with cookie binding enabled require both the hidden `__ferrite_csrf` field and the named cookie to match the configured token.
- Updated systemd/container templates to enable the cookie binding flag.
- Updated deployment, architecture, README, GTM, and status docs to distinguish implemented double-submit cookie binding from remaining session-bound CSRF and replay protection.

## Focused Proof

Passed before the full verification gate:

```sh
cargo fmt --all && \
cargo test -p ferrite-dev-server -- action_form_csrf_guard_requires_matching_configured_token action_form_csrf_cookie_guard_requires_matching_cookie production_action_csrf_cookie_binding_sets_cookie_and_rejects_missing_cookie && \
cargo test -p ferrite-cli -- serve_accepts_server_action_csrf_cookie_name_flag server_action_csrf_cookie_name_requires_token_and_cookie_safe_values && \
node --test scripts/verify-deployment-templates.test.mjs
```

This proved:

- the existing hidden CSRF token guard still accepts matching tokens and rejects missing, wrong, or duplicate token fields,
- cookie binding accepts a matching cookie and rejects missing or mismatched cookies,
- production response cookie construction uses `Path=/; SameSite=Lax; HttpOnly; Secure`,
- the CLI parses the cookie-name flag,
- the CLI rejects cookie binding without a configured CSRF token,
- the CLI rejects invalid cookie names and cookie-unsafe token values,
- deployment templates include the cookie binding flag.

## Full Verification

Passed before commit:

```sh
cargo fmt --all
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:release
pnpm release:verify:npm
cargo test --workspace
cargo fmt --all -- --check
git diff --check
```

## Remaining Gaps

- The cookie binding uses the configured CSRF token; it is not session-bound token rotation.
- Replay protection is still not implemented.
- App-owned auth middleware and session cookie guidance still need to be designed and proven.
- No hosted staging deployment has exercised the cookie binding behind the real TLS/proxy topology.
- Registry publishing, remote CI, push, and PR proof remain blocked in this checkout until a Git remote is configured.
