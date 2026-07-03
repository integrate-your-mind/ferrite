# Milestone 085: Production Server-Action Audit Logs

Date: 2026-07-03

## What Changed

- Added production server-action observer events for action attempts that reach `POST /_ferrite/action`.
- Recorded accepted action responses, parse rejections, unmatched routes, unknown action ids, and render error responses with status and accepted/rejected outcome.
- Included only action id, submitted route path, matched route pattern, response status, action outcome, derived client IP, and elapsed duration.
- Kept request headers, request bodies, form fields, and CSRF tokens out of the action event shape and CLI logs.
- Added `ferrite serve --action-log plain|json` for stderr server-action audit logs.
- Updated systemd and container templates to run with `--action-log json` alongside JSON request access logs.
- Updated deployment, architecture, README, status audit, and GTM docs so action audit logging is treated as first-pass local proof, not as hosted or external-sink proof.

## Focused Proof

Passed before the full verification gate:

```sh
cargo fmt --all && \
cargo test -p ferrite-dev-server -- production_action_observer_records_success_and_rejection_without_form_data production_action_observer_records_parse_rejections && \
cargo test -p ferrite-cli -- serve_accepts_action_log_format_flag formats_action_log_events_without_form_data_or_tokens && \
node --test scripts/verify-deployment-templates.test.mjs
```

This proved:

- successful action attempts produce accepted audit events,
- malformed action submissions produce rejected audit events,
- derived client IP is available in action events,
- CLI action log output supports plain and JSON formats,
- CLI action log JSON does not expose form data, headers, bodies, or CSRF tokens,
- deployment templates include the production action-log flag.

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

- Action logs are CLI stderr output only; there are still no first-class external metrics, tracing, or audit sinks.
- No hosted staging deployment has captured request/action logs behind a real proxy.
- Server actions still need session-bound CSRF, token rotation, replay guidance, cookie/auth guidance, and deployment-stable action ids before real public mutation workloads.
- Registry publishing, remote CI, push, and PR proof remain blocked in this checkout until a Git remote is configured.
