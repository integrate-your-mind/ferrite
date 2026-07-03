# Milestone 084: Trusted Proxy Client IP Policy

Date: 2026-07-03

## What Changed

- Added `client_ip` to production request observer events and CLI access logs.
- Added `--trusted-proxy-client-ip-hops` to `ferrite serve`.
- Kept TCP peer IP as the default client IP source.
- Made `X-Forwarded-For` trusted only when an explicit trusted-proxy hop count is configured.
- Updated systemd and container templates to use `--trusted-proxy-client-ip-hops 1` with the nginx template's sanitized `X-Forwarded-For` chain.
- Updated deployment, architecture, README, GTM, and status docs to remove forwarded client-IP policy from the open server-action hardening backlog.

## Proof

- Focused tests passed:
  - `cargo test -p ferrite-dev-server -- trusted_proxy_client_ip_policy_uses_configured_forwarded_hops production_action_post_observes_real_socket_requests`
  - `cargo test -p ferrite-cli -- trusted_proxy_client_ip_hops_requires_positive_value trusted_proxy_client_ip_hops_requires_trusted_proxy_origin serve_accepts_trusted_proxy_client_ip_hops_flag formats_access_log_events_without_headers_or_body`
- Full verification passed before commit:
  - `cargo fmt --all`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
  - `pnpm test:release`
  - `pnpm release:verify:npm`
  - `cargo test --workspace`
  - `cargo fmt --all -- --check`
  - `git diff --check`

## Remaining Gaps

- The policy is local/test proven but has not been exercised behind a hosted staging proxy.
- Server actions still need session-bound CSRF token rotation, replay protection, cookie/auth integration guidance, and deployment-stable inferred action IDs.
- Access logs still emit to stderr only; first-class metrics/tracing sinks remain future work.
- Remote CI, push, and PR proof remain unavailable because this checkout has no configured Git remote.
