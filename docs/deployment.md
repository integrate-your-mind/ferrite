# Ferrite Deployment Guide

Date: 2026-07-03

This guide describes the current production-shaped deployment path for a Ferrite app. It is an operator checklist for the existing `ferrite build` and `ferrite serve` commands, not proof that Ferrite has already been deployed behind a real CDN, TLS terminator, process manager, or npm release.

## Current Production Shape

Ferrite can:

- typecheck an app and write generated route types with `ferrite check`
- build route manifests, static HTML, generated client assets, and action bootstrap assets with `ferrite build`
- serve dynamic app routes with the production HTTP adapter through `ferrite serve`
- serve generated assets under `/_ferrite/static`
- return server-payload JSON with `?__ferrite_payload=server`
- return line-delimited server-payload stream frames with `?__ferrite_payload=stream`
- accept explicit form-based server-action POSTs at `POST /_ferrite/action`
- require a valid `Host` header for action POSTs and reject action POSTs when browser-supplied `Origin` or `Referer` hosts differ from `Host`
- optionally require a hidden server-action CSRF token loaded from an environment variable
- optionally bind the hidden server-action CSRF token to a SameSite/HttpOnly/Secure double-submit cookie in production
- derive access-log client IPs from the TCP peer by default, or from `X-Forwarded-For` only when an explicit trusted-proxy hop count is configured
- emit request outcome access logs and server-action audit logs to stderr in plain or JSON format
- gzip eligible HTML and payload responses when `Accept-Encoding` allows it
- bound request reads, request size, in-flight workers, and render subprocess timeouts
- drain accepted production requests through the Rust shutdown-aware listener API

## Release Prerequisites

Before treating a deployment as releasable, prove these gates in the same revision that will be deployed:

```sh
pnpm install --frozen-lockfile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:release
pnpm release:verify:npm
cargo test --workspace
cargo run -p ferrite-cli -- check --project examples/basic
cargo run -p ferrite-cli -- build --project examples/basic
cargo run -p ferrite-cli -- serve --project examples/basic --once --request-path /posts/abc
cargo run -p ferrite-cli -- serve --project examples/basic --once --request-path '/posts/abc?__ferrite_payload=server'
cargo run -p ferrite-cli -- serve --project examples/basic --once --request-path '/posts/abc?__ferrite_payload=stream'
```

Remote release gates are still required once a GitHub remote exists:

- CI lint, typecheck, build, tests, and browser tests
- npm package tarball verification in CI
- native prebuild dry-run matrix on supported hosted runners
- artifact upload and review for npm package reports and native prebuilds

## Private Alpha Operator Gate

Before giving this to an external private-alpha team, capture evidence for the
exact revision and artifact they will use:

- GitHub PR and remote CI link for the revision.
- Release artifact source, either private npm package, verified tarball bundle,
  or pinned source checkout.
- Hosted staging URL behind the chosen proxy/TLS boundary.
- Smoke-test transcript for HTML, server-payload JSON, server-payload stream,
  static asset, metrics, and server-action rejection paths.
- Access-log, action-log, and metrics scrape samples from staging.
- Rollback command or image/tag rollback record.
- Explicit allowed-use statement covering no public SLA, no file uploads, no
  auth-sensitive server-action mutations unless app-owned auth/CSRF has been
  reviewed separately, and no React Flight/RSC compatibility claim.

## Topology

Run Ferrite behind a production reverse proxy or ingress that owns:

- TLS termination
- HTTP/2 or HTTP/3 negotiation
- request buffering policy
- compression policy if proxy compression is preferred over Ferrite gzip
- rate limiting and abuse controls
- access logs and trace correlation
- health checks and process restarts

The Ferrite production adapter is currently a direct HTTP/1.1 application server. Bind it to a private interface when a proxy is present:

```sh
cargo run -p ferrite-cli -- serve --project /srv/app --host 127.0.0.1 --port 3000
```

Expose only the proxy publicly. Forward `Host` unchanged unless `--trusted-proxy-public-origin` is configured. If trusted-proxy mode is enabled, the proxy must set `X-Forwarded-Proto` and `X-Forwarded-Host` to the public origin values and must strip any client-supplied copies of those headers before forwarding. Ferrite does not trust `X-Forwarded-For` by default; set `--trusted-proxy-client-ip-hops` only when the proxy owns and sanitizes the forwarded chain.

## Build And Start

Build the app during release preparation:

```sh
cargo run -p ferrite-cli -- check --project /srv/app
cargo run -p ferrite-cli -- build --project /srv/app --out /srv/app/.ferrite/build
```

Start the production server:

```sh
export FERRITE_ACTION_CSRF='<generated-secret-token>'
cargo run -p ferrite-cli -- serve \
  --project /srv/app \
  --host 127.0.0.1 \
  --port 3000 \
  --render-timeout-ms 30000 \
  --request-read-timeout-ms 5000 \
  --max-request-bytes 16384 \
  --max-in-flight-requests 64 \
  --server-action-csrf-token-env FERRITE_ACTION_CSRF \
  --server-action-csrf-cookie-name ferrite_action_csrf \
  --server-action-replay-ttl-ms 300000 \
  --trusted-proxy-public-origin https://app.example.com \
  --trusted-proxy-client-ip-hops 1 \
  --access-log json \
  --action-log json \
  --metrics-path /__ferrite/metrics
```

For a packaged binary, run the installed `ferrite` executable with the same arguments.

## Deployment Templates

Ferrite includes first-pass deployment templates for a private-beta topology:

- `deploy/systemd/ferrite.service`: process manager template for a private `127.0.0.1:3000` Ferrite service.
- `deploy/nginx/ferrite.conf`: TLS-terminating reverse-proxy template that owns `Host`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
- `deploy/ferrite.env.example`: runtime environment variables for CSRF and public origin configuration.
- `deploy/container/Dockerfile`: container template that builds the workspace, runs as a non-root runtime user, and starts `ferrite serve` with production limits, CSRF cookie binding, one-time server-action replay nonces, trusted-proxy origin checks, trusted forwarded client-IP hop count, JSON access logs, JSON action audit logs, and a Prometheus text metrics endpoint.

These templates are checked by `scripts/verify-deployment-templates.test.mjs`. The container template also has a local Docker build and container smoke for the basic example route, including JSON access-log output. This is still not proof of a hosted staging deployment. Before using these templates for a paid beta, run the chosen template behind the real proxy, capture access logs, run the smoke tests below, and record rollback steps for the exact artifact version.

## Runtime Configuration

Use command arguments for the current runtime knobs:

- `--project`: app root
- `--host`: bind address
- `--port`: bind port
- `--render-timeout-ms`: maximum route render subprocess duration
- `--request-read-timeout-ms`: maximum time to wait while reading each production HTTP request
- `--max-request-bytes`: maximum bytes allowed for each production HTTP request header and body
- `--max-in-flight-requests`: maximum production requests handled concurrently
- `--server-action-csrf-token-env`: environment variable containing the token rendered into server-action forms and required on action POSTs
- `--server-action-csrf-cookie-name`: optional cookie name that binds action POSTs to the configured CSRF token; it requires `--server-action-csrf-token-env`, sets `Path=/; SameSite=Lax; HttpOnly; Secure` on production route responses, and rejects action POSTs without a matching cookie value
- `--server-action-replay-ttl-ms`: optional positive TTL for one-time server-action replay nonces rendered into production forms; it requires `--server-action-csrf-token-env`, rejects missing or reused nonces, stores nonce state in the current Ferrite process, and treats a nonce as single-use for the rendered response
- `--trusted-proxy-public-origin`: optional public HTTP(S) origin for server-action POST origin checks behind a trusted reverse proxy; when set, action POSTs require matching `X-Forwarded-Proto` and `X-Forwarded-Host`
- `--trusted-proxy-client-ip-hops`: optional `X-Forwarded-For` trust policy for access-log `client_ip`; it requires `--trusted-proxy-public-origin` and selects the client IP before the configured number of trusted proxy hops
- `--access-log`: optional `plain` or `json` production request outcome logs emitted to stderr
- `--action-log`: optional `plain` or `json` production server-action audit logs emitted to stderr
- `--metrics-path`: optional absolute path that exposes in-memory request and server-action counters in Prometheus text format; the path must not shadow `/_ferrite/action`
- `--once`: deterministic one-request mode for smoke tests
- `--request-path`: request target for `--once` smoke tests

The production adapter also has Rust API-level observer hooks. The CLI currently exposes the main request/render limits, server-action CSRF cookie binding, server-action trusted-proxy public-origin checks, trusted forwarded client-IP log policy, stderr request access logs, stderr action audit logs, and in-memory Prometheus-style counters, but not tracing sinks or external audit sinks.

## Smoke Tests

After starting a candidate deployment, verify at least:

```sh
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/posts/abc
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=server'
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=stream'
curl -i -H 'Accept-Encoding: gzip' http://127.0.0.1:3000/posts/abc
curl -i http://127.0.0.1:3000/_ferrite/static/<known-built-asset>
curl -i http://127.0.0.1:3000/__ferrite/metrics
```

For routes with server-action forms, submit a normal same-host action POST with the rendered `__ferrite_csrf` field, a missing-token rejection probe, and a cross-origin rejection probe. If `--server-action-csrf-cookie-name` is enabled, verify the route response sets the named cookie and that an action POST without that cookie is rejected. If `--server-action-replay-ttl-ms` is enabled, verify the rendered form includes `__ferrite_nonce`, the first action POST succeeds, and replaying the exact same body is rejected. If `--trusted-proxy-public-origin` is enabled, include a proxy-path smoke that proves matching `X-Forwarded-Proto` and `X-Forwarded-Host` are accepted and mismatches are rejected. Do not treat server actions as auth-complete until token rotation/session binding, auth integration, and multi-process replay coordination are implemented.

## Observability

Ferrite's Rust production API can attach request observer hooks that receive:

- method
- path
- status
- route pattern
- client IP, derived from the TCP peer unless an explicit trusted `X-Forwarded-For` hop policy is configured
- elapsed duration

Ferrite's Rust production API can also attach server-action observer hooks that receive:

- action id when the request parsed far enough to identify one
- submitted route path when the request parsed far enough to identify one
- matched route pattern when known
- response status
- accepted or rejected outcome
- client IP, derived from the same trusted-client-IP policy used for request logs
- elapsed duration

Applications embedding the Rust server should bridge those events into their logging, metrics, tracing, or audit stack. The CLI can expose in-memory request/action counters through `--metrics-path`; those counters intentionally label by method/status/route pattern and action outcome/status/route pattern, not request bodies, form fields, headers, CSRF tokens, or raw dynamic URL values. The CLI does not yet expose first-class external log sink configuration, trace IDs, tracing exporters, or external audit exporters.

The CLI can emit request outcome access logs to stderr:

```sh
cargo run -p ferrite-cli -- serve --project /srv/app --access-log plain
cargo run -p ferrite-cli -- serve --project /srv/app --access-log json
cargo run -p ferrite-cli -- serve --project /srv/app --action-log plain
cargo run -p ferrite-cli -- serve --project /srv/app --action-log json
cargo run -p ferrite-cli -- serve --project /srv/app --metrics-path /__ferrite/metrics
```

Access log events include method, path, status, route pattern when known, derived client IP when available, and elapsed milliseconds. Action log events include action id, submitted route path, matched route pattern when known, status, accepted/rejected outcome, derived client IP when available, and elapsed milliseconds. Neither CLI log path includes request headers, request bodies, form fields, CSRF tokens, or replay nonces, so server-action form data and generated secrets are not logged by the Ferrite CLI access-log or action-log paths.

At the proxy layer, capture:

- request id
- method, host, path, and status
- upstream latency
- response bytes
- TLS protocol and cipher
- client disconnects and upstream timeouts
- rate-limit decisions

## Rollback

Keep every deployment artifact versioned:

- source commit
- generated `.ferrite/build` output
- package versions
- native prebuild checksums
- runtime command arguments
- proxy configuration

Rollback should restore the previous artifact set and restart the Ferrite process behind the proxy. Because generated client assets are content-addressed and served with immutable cache headers, never overwrite old asset files in-place while older HTML can still reference them. Prefer atomic release directories or image tags.

## Security Notes

Current production hardening is incomplete. Ferrite can require one configured hidden server-action CSRF token for rendered forms and can bind that token to a SameSite/HttpOnly/Secure double-submit cookie, but before handling real authenticated mutations it still needs:

- CSRF token rotation and session binding for server actions
- multi-process or external replay nonce storage for horizontally scaled deployments
- deployment-stable inferred action IDs or an explicit persistent action registry
- app/auth-owned cookie and SameSite guidance for session-specific secrets
- upload/file-part policy if file actions are enabled later
- external tracing and audit sinks beyond stderr request/action logs and in-memory metrics counters

Until those exist, deploy server actions only for controlled beta scenarios or behind app-owned authentication and CSRF middleware that has been reviewed separately. If server actions are enabled in production, set `--server-action-csrf-token-env`, prefer `--server-action-csrf-cookie-name`, and set `--server-action-replay-ttl-ms` when a single Ferrite process owns the action form and action POST path. Rotate the referenced CSRF secret as part of the deployment process. The configured token must be cookie-safe when cookie binding is enabled. If the public TLS origin differs from the upstream Ferrite bind origin, set `--trusted-proxy-public-origin` and configure the proxy to own and sanitize the forwarded proto/host headers. If access logs need public client IPs behind the proxy, set `--trusted-proxy-client-ip-hops` to the exact number of trusted proxy hops and make the edge proxy overwrite `X-Forwarded-For`.

## Known Gaps

- No npm packages are published yet.
- No GitHub remote or remote CI proof exists in this checkout.
- Native prebuild artifacts have local and workflow dry-run proof, but not hosted-runner proof from this checkout.
- The production CLI exposes the main request/render limits, server-action CSRF cookie binding, server-action trusted-proxy public-origin checks, trusted forwarded client-IP log policy, stderr request access logs, stderr action audit logs, and an in-memory Prometheus text metrics endpoint, but not tracing sinks or external audit sinks.
- First-pass container, systemd, and nginx templates exist with local static verification and container smoke proof, but no official container image, Helm chart, managed platform adapter, or hosted staging proof exists yet.
- There is no first-class tracing integration or external metrics sink beyond the in-memory Prometheus text scrape endpoint.
- The server-payload contract is Ferrite-owned and not React Flight-compatible.
