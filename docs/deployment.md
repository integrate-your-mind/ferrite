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

Expose only the proxy publicly. Forward `Host` unchanged and sanitize untrusted forwarding headers until Ferrite has first-class trusted-proxy configuration.

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
  --server-action-csrf-token-env FERRITE_ACTION_CSRF
```

For a packaged binary, run the installed `ferrite` executable with the same arguments.

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
- `--once`: deterministic one-request mode for smoke tests
- `--request-path`: request target for `--once` smoke tests

The production adapter also has Rust API-level observer hooks. The CLI currently exposes the main request and render limits, but not structured log sinks, metrics exporters, or trusted-proxy settings.

## Smoke Tests

After starting a candidate deployment, verify at least:

```sh
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/posts/abc
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=server'
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=stream'
curl -i -H 'Accept-Encoding: gzip' http://127.0.0.1:3000/posts/abc
curl -i http://127.0.0.1:3000/_ferrite/static/<known-built-asset>
```

For routes with server-action forms, submit a normal same-host action POST with the rendered `__ferrite_csrf` field, a missing-token rejection probe, and a cross-origin rejection probe. Do not treat server actions as auth-complete until token rotation/session binding, auth integration, and replay protection are implemented.

## Observability

Ferrite's Rust production API can attach request observer hooks that receive:

- method
- path
- status
- route pattern
- elapsed duration

Applications embedding the Rust server should bridge those events into their logging, metrics, or tracing stack. The CLI does not yet expose first-class log sink configuration, structured access logs, trace IDs, or metrics exporters.

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

Current production hardening is incomplete. Ferrite can require one configured hidden server-action CSRF token for rendered forms, but before handling real authenticated mutations it still needs:

- CSRF token rotation and session binding for server actions
- replay protection guidance
- deployment-stable inferred action IDs or an explicit persistent action registry
- trusted-proxy configuration for forwarded host, protocol, and client IP headers
- cookie and SameSite guidance
- upload/file-part policy if file actions are enabled later
- structured audit logging for action attempts and rejections

Until those exist, deploy server actions only for controlled beta scenarios or behind app-owned authentication and CSRF middleware that has been reviewed separately. If server actions are enabled in production, set `--server-action-csrf-token-env` and rotate the referenced secret as part of the deployment process.

## Known Gaps

- No npm packages are published yet.
- No GitHub remote or remote CI proof exists in this checkout.
- Native prebuild artifacts have local and workflow dry-run proof, but not hosted-runner proof from this checkout.
- The production CLI exposes the main request and render limits, but not structured log sinks, metrics exporters, or trusted-proxy settings.
- There is no official container image, systemd unit, Helm chart, or managed platform adapter.
- There is no first-class metrics exporter or tracing integration.
- The server-payload contract is Ferrite-owned and not React Flight-compatible.
