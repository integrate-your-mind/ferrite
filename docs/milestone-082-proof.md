# Milestone 082: Trusted Proxy Action Origin

Date: 2026-07-03

## What Changed

- Added `ProductionTrustedProxyConfig` for explicit production trusted-proxy public-origin configuration.
- Added `ferrite serve --trusted-proxy-public-origin <origin>` for server-action POST deployments behind a reverse proxy.
- Kept default server-action origin checks backward compatible: without trusted-proxy config, browser `Origin` and `Referer` authorities are compared to `Host`.
- In trusted-proxy mode, server-action POSTs require `X-Forwarded-Proto` and `X-Forwarded-Host` to match the configured public origin before browser `Origin` or `Referer` is accepted.
- Added real production socket proof that a server-action POST with an internal `Host` and matching forwarded public origin reaches the action handler.
- Updated deployment, architecture, audit, README, and GTM documentation to separate implemented trusted-proxy public-origin checks from remaining session/replay/auth/client-IP hardening.

## Proof

- `cargo fmt --all && cargo test -p ferrite-dev-server trusted_proxy && cargo test -p ferrite-cli trusted_proxy`: passed.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- This is not session-bound CSRF, replay protection, or auth middleware integration.
- Trusted-proxy mode validates forwarded proto/host for server-action origin checks; it does not define a forwarded client-IP trust policy.
- The behavior is locally tested but not proven behind a real hosted reverse proxy because this checkout has no configured Git remote or deployed staging environment.
