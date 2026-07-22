# Ferrite Deployment Guide

Updated: 2026-07-12

This guide describes the current production-shaped deployment path for a Ferrite app. It is an operator checklist for the existing `ferrite build` and `ferrite serve` commands, not proof that Ferrite has already been deployed behind a real CDN, TLS terminator, process manager, or npm release.

## Current Production Shape

Ferrite can:

- typecheck an app and write generated route types with `ferrite check`
- stage a versioned production manifest, self-contained route modules, optional static HTML, generated client assets, build-observed action metadata, and SHA-256 file records with `ferrite build`
- validate and serve that immutable artifact with the production HTTP adapter through `ferrite serve`
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
- bound each request read with one absolute deadline, plus request size, in-flight workers, and render subprocess timeouts
- stop admission and drain accepted production requests on CLI `SIGINT`/`SIGTERM` or through the Rust shutdown-aware listener API

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
pnpm release:verify:cargo
cargo test --workspace
cargo run -p ferrite-cli -- check --project examples/basic
cargo run -p ferrite-cli -- build --project examples/basic
cargo run -p ferrite-cli -- serve --project examples/basic --artifact .ferrite/build --page-renderer packages/runtime/bin/render-artifact.mjs --once --request-path /posts/abc
cargo run -p ferrite-cli -- serve --project examples/basic --artifact .ferrite/build --page-renderer packages/runtime/bin/render-artifact.mjs --once --request-path '/posts/abc?__ferrite_payload=server'
cargo run -p ferrite-cli -- serve --project examples/basic --artifact .ferrite/build --page-renderer packages/runtime/bin/render-artifact.mjs --once --request-path '/posts/abc?__ferrite_payload=stream'
```

Remote release gates are still required before release. The GitHub repository and PR flow now exist, but hosted Actions has not yet produced job-level proof for this codebase:

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
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --page-renderer /srv/app/packages/runtime/bin/render-artifact.mjs --host 127.0.0.1 --port 3000
```

Expose only the proxy publicly. Forward `Host` unchanged unless `--trusted-proxy-public-origin` is configured. If trusted-proxy mode is enabled, the proxy must set `X-Forwarded-Proto` and `X-Forwarded-Host` to the public origin values and must strip any client-supplied copies of those headers before forwarding. Ferrite does not trust `X-Forwarded-For` by default; set `--trusted-proxy-client-ip-hops` only when the proxy owns and sanitizes the forwarded chain.

## HTTP Request Contract

The Rust dev and production adapters intentionally share one narrow proxy-upstream parser rather than implementing separate permissive and strict paths. `httparse` owns request-line and header syntax; Ferrite applies the stricter framing, authority, target, and body policy below. Direct HTTP/1.0, bare-LF, and absolute-form compatibility is therefore not supported at either application socket; normal browser HTTP/1.1 remains supported, and the edge proxy owns legacy protocol normalization:

- requests must use exact HTTP/1.1, CRLF line endings, an origin-form target beginning with `/`, and one valid `Host` authority
- percent-encoded `.`, `/`, and `\` bytes are rejected in the path by both Ferrite and the stock nginx map; percent encoding remains valid in query values
- request heads are bounded by `--max-request-bytes` and at most 100 header fields
- `Transfer-Encoding` and `Expect` are rejected; Ferrite does not accept chunked request bodies or emit `100 Continue`
- positive-length request bodies are accepted only for `POST /_ferrite/action`, with one decimal `Content-Length`
- duplicate framing or interpreted fields are rejected case-insensitively, including `Content-Length`, `Transfer-Encoding`, `Host`, `Content-Type`, `Cookie`, `Expect`, `Origin`, `Referer`, and trusted `X-Forwarded-*` fields; comma-joined forwarded proto/host values also fail closed, while other repeatable fields are comma-combined in wire order
- one request is processed per connection and every response closes the connection; already-buffered bytes beyond the declared request are rejected, and HTTP pipelining is unsupported

The supplied nginx template keeps request buffering enabled, accepts HTTP/1.1 and HTTP/2 at the TLS edge, and speaks HTTP/1.1 to Ferrite. It fails closed on request-target forms by default, allowing only origin-form targets that do not begin with `//` and canonical HTTPS absolute-form targets for the configured public authority. It also rejects raw `Host` authorities outside that public host, overwrites the accepted authority and forwarded-origin fields, clears hop-by-hop `Connection`, and strips `Expect`. Keep both `map` entries and `server_name` aligned when changing the public host; the raw-authority and raw-target maps deliberately reject missing hosts, explicit ports, mismatched or alternate schemes, network-path targets, and alternate absolute-form authorities. As a conservative normalization defense, the stock target map rejects any path containing percent-encoded `.`, `/`, or `\` bytes and any literal `.` or `..` path segment. This also rejects otherwise legitimate opaque identifiers containing those encodings; applications that require them need a separately reviewed edge policy and regression matrix rather than silently weakening the supplied map. The [nginx request-buffering contract](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering) reads the complete client body before sending it upstream. The template requires nginx 1.25.1 or newer because it uses the non-deprecated `http2` directive. An exact local evidence run against official `nginx:1.29.3-alpine` proves that client-side chunked and HTTP/2 DATA-frame action bodies are normalized into Ferrite-compatible requests in that version; rerun the matrix against the exact deployed proxy image rather than assuming all versions behave identically. Do not expose Ferrite as an unmanaged Internet edge or configure a proxy that forwards raw ambiguous framing.

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
  --artifact .ferrite/build \
  --page-renderer /srv/app/packages/runtime/bin/render-artifact.mjs \
  --host 127.0.0.1 \
  --port 3000 \
  --render-timeout-ms 30000 \
  --request-read-timeout-ms 5000 \
  --response-write-timeout-ms 5000 \
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
- `deploy/nginx/ferrite.conf`: TLS-terminating reverse-proxy template that rejects unknown authorities, buffers requests, owns `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For`, strips unsupported `Expect`, clears hop-by-hop `Connection`, and blocks the in-process metrics path from public proxy traffic.
- `deploy/ferrite.env.example`: runtime environment variables for CSRF and public origin configuration.
- `deploy/container/Dockerfile`: container template that builds the workspace and example artifact, then copies only the CLI, dependency-free artifact runner, and verified artifact into the final image rather than application source, workspace packages, or `node_modules`. It runs as a non-root runtime user and starts artifact-backed `ferrite serve` with production limits, CSRF cookie binding, one-time server-action replay nonces, trusted-proxy origin checks, trusted forwarded client-IP hop count, JSON access logs, and JSON action audit logs. Its directly exposed default does not enable the metrics endpoint.

These templates are checked statically by `scripts/verify-deployment-templates.test.mjs`. `scripts/verify-nginx-runtime.mjs` sends a real raw-TLS normal/failure/odd-path matrix through a running nginx and Ferrite pair, then checks the Ferrite JSON access log to prove baseline requests reached the upstream while smuggling canaries did not. The exact artifact-only container also builds locally and has a runtime smoke proving a dynamic route, fingerprinted asset, JSON access log, non-root user, and absence of workspace packages and `node_modules`. None of this is hosted deployment proof. Before using these templates for a paid beta, run the chosen template behind the real proxy, capture access logs, run the smoke tests below, and record rollback steps for the exact artifact version.

## Runtime Configuration

Use command arguments for the current runtime knobs:

- `--project`: app root
- `--artifact`: immutable build directory relative to `--project` unless absolute; startup fails before serving when the manifest or any declared file is missing, incompatible, unsafe, or fails size/SHA-256 validation
- `--page-renderer`: production artifact runner path; use `packages/runtime/bin/render-artifact.mjs`, not the build/dev `render-page.mjs`
- `--host`: bind address
- `--port`: bind port
- `--render-timeout-ms`: maximum duration for each production artifact-runner subprocess
- `--request-read-timeout-ms`: absolute budget across all header and body reads for one production HTTP request; trickled bytes do not renew it and the minimum effective value is 1 ms
- `--response-write-timeout-ms`: absolute budget across headers and all fixed, gzip, or chunked writes for one production HTTP response; the minimum effective value is 1 ms
- `--max-request-bytes`: maximum bytes allowed for each production HTTP request header and body
- `--max-in-flight-requests`: maximum accepted production sockets across active and queued work; excess connections receive `503 Service Unavailable`
- `--server-action-csrf-token-env`: environment variable containing the token rendered into server-action forms and required on action POSTs
- `--server-action-csrf-cookie-name`: optional cookie name that binds action POSTs to the configured CSRF token; it requires `--server-action-csrf-token-env`, sets `Path=/; SameSite=Lax; HttpOnly; Secure` on production route responses, and rejects action POSTs without a matching cookie value
- `--server-action-replay-ttl-ms`: optional positive TTL for one-time server-action replay nonces rendered into production forms; it requires `--server-action-csrf-token-env`, rejects missing or reused nonces, stores at most 4,096 live nonces in the current Ferrite process, evicts the oldest unused nonce under capacity pressure, and treats a nonce as single-use for the rendered response
- `--trusted-proxy-public-origin`: optional public HTTP(S) origin for server-action POST origin checks behind a trusted reverse proxy; when set, action POSTs require matching `X-Forwarded-Proto` and `X-Forwarded-Host`
- `--trusted-proxy-client-ip-hops`: optional `X-Forwarded-For` trust policy for access-log `client_ip`; it requires `--trusted-proxy-public-origin` and selects the client IP before the configured number of trusted proxy hops. The edge proxy must overwrite client-supplied `X-Forwarded-For` before any trusted internal proxy appends to it.
- `--access-log`: optional `plain` or `json` production request outcome logs emitted to stderr
- `--action-log`: optional `plain` or `json` production server-action audit logs emitted to stderr
- `--metrics-path`: optional absolute path that exposes in-memory request and server-action counters in Prometheus text format; the path must not shadow `/_ferrite/action`
- `--once`: deterministic one-request mode for smoke tests
- `--request-path`: request target for `--once` smoke tests

The production adapter also has Rust API-level observer hooks. The CLI currently exposes the main request/render/write limits, server-action CSRF cookie binding, server-action trusted-proxy public-origin checks, trusted forwarded client-IP log policy, stderr request access logs, stderr action audit logs, and in-memory Prometheus-style counters, but not tracing sinks or external audit sinks.

If the response-write deadline expires before any bytes are sent, the connection closes with no response. If it expires after a header or body prefix is sent, the client receives a truncated response and the connection closes; Ferrite cannot safely replace an in-progress HTTP response with a new error document. The concurrent server emits a generic response-write deadline message to stderr. Overload `503` responses use the smaller of the configured deadline and 100 ms so rejected sockets do not hold the accept loop for the normal response budget.

## Smoke Tests

After starting a candidate deployment, verify at least:

```sh
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/posts/abc
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=server'
curl -i 'http://127.0.0.1:3000/posts/abc?__ferrite_payload=stream'
curl -i -H 'Accept-Encoding: gzip' http://127.0.0.1:3000/posts/abc
curl -i http://127.0.0.1:3000/_ferrite/static/<known-built-asset>
curl -i http://127.0.0.1:3000/__ferrite/metrics # private upstream only
```

For routes with server-action forms, submit a normal same-host action POST with the rendered `__ferrite_csrf` field, a missing-token rejection probe, and a cross-origin rejection probe. If `--server-action-csrf-cookie-name` is enabled, verify the route response sets the named cookie and that an action POST without that cookie is rejected. If `--server-action-replay-ttl-ms` is enabled, verify the rendered form includes `__ferrite_nonce`, the first action POST succeeds, and replaying the exact same body is rejected. If `--trusted-proxy-public-origin` is enabled, include a proxy-path smoke that proves matching `X-Forwarded-Proto` and `X-Forwarded-Host` are accepted and mismatches are rejected. Do not treat server actions as auth-complete until token rotation/session binding, auth integration, and multi-process replay coordination are implemented.

Run the complete local candidate-image and proxy proof from the repository root:

```sh
pnpm test:nginx:stack
```

This command requires Node.js, OpenSSL, `tar`, and a reachable Docker daemon. It refuses a dirty worktree by default, reports the exact Git commit/tree, exports that commit into an immutable source root, and reads the Dockerfile, nginx template, child verifier, and candidate build context only from that root. It resolves official nginx 1.29.3 from an immutable multi-platform index digest, records the platform-specific image id and architecture, labels the production image with the source revision/tree, creates an isolated bridge network, and runs the built artifact behind an ephemeral TLS listener. It first proves that nginx rejects missing certificate material, validates the generated config with `nginx -t`, then executes 43 raw HTTP/1 cases and seven negotiated HTTP/2 cases. Nginx JSON access evidence requires all five ambiguous-framing probes to return `400` and all nine malformed-target probes to return `421`, each without an upstream status, preventing a Ferrite-generated response from falsely proving edge rejection. Additional negative controls prove default certificate validation, mandatory Ferrite log evidence, the response-size cap, a stalled-TLS deadline, and synthetic smuggling-canary detection. Handled success, failure, repeated `SIGINT`, and repeated `SIGTERM` paths terminate owned child processes, remove the uniquely named containers, network, candidate image tag, log follower, and scratch directory, and poll to verify their absence. An uncatchable process kill, host loss, or Docker daemon loss can still interrupt cleanup; resources use the `ferrite-proof-` or `nginx-proof-` name prefixes so an operator can inspect ownership before removing leftovers.

The harness runs the production image and nginx as separate containers on the same private bridge network. It does not rely on Docker host networking or a platform-specific host-gateway alias. The successful local certificate is intentionally self-signed; the harness disables verification only for the successful matrix and separately proves that the secure default rejects it. Run this command from a clean exact commit for release evidence. `FERRITE_NGINX_ALLOW_DIRTY=1` exists only for non-release development runs; such runs are labeled dirty and are not exact-SHA proof. The harness prints the candidate image id, source labels, nginx digest and architecture, and the Ferrite production build id emitted by the image build.

The nginx reference is an immutable multi-platform index, so the harness records the architecture-specific image that Docker resolves rather than claiming the same image id across platforms. The candidate Dockerfile still starts from mutable Rust and Node image tags and installs packages from external repositories; this is executable source/runtime proof, not a bit-for-bit reproducible image build. The harness currently assumes POSIX process signals and Docker's `127.0.0.1:<port>` publication format, as provided by the tested macOS/Linux Docker path. Native Windows host behavior remains unproven.

To test an already-running candidate proxy instead, start Ferrite with `--access-log json`, retain its absolute log path, and invoke the lower-level raw framing verifier:

```sh
FERRITE_NGINX_HOST=127.0.0.1 \
FERRITE_NGINX_PORT=8443 \
FERRITE_NGINX_SERVER_NAME=app.example.com \
FERRITE_NGINX_ACCESS_LOG_PATH=/absolute/path/to/ferrite-access.log \
pnpm test:nginx
```

The lower-level verifier reads only entries appended after it starts. It requires successful GET and action records with the expected method, status, route pattern, elapsed time, and a valid trusted-proxy IPv4 client address, correlates the distinct HTTP/2 GET/action routes, and proves that a client-supplied forwarded IP never appears in Ferrite logs. It also rejects any access-log evidence that a malformed-framing or malformed-target canary reached Ferrite. It validates TLS certificates by default, negotiates HTTP/1.1 and HTTP/2 explicitly, gracefully closes successful HTTP/2 sessions, aborts failed sessions, bounds each complete exchange and response size, and reports its target and TLS-verification mode. Set `FERRITE_NGINX_INSECURE=1` only for an isolated local self-signed certificate. The raw HTTP/1 matrix covers normal GET/action requests, client-side chunked actions, duplicate and conflicting `Content-Length`, `Transfer-Encoding` combinations with smuggling canaries, duplicate authority/origin/referer/cookie fields, obsolete folding and whitespace, canonical and mixed-case HTTPS absolute-form, mixed-case alternate schemes, encoded slash/backslash/dot and literal dot-segment rejection, malformed authorities, network-path and bare-authority targets, HTTP/1.0 and bare-LF edge canonicalization, `Expect`, forwarded-header spoofing, and two pipelined client requests. The HTTP/2 matrix proves ALPN negotiation, a normal GET, DATA-frame action bodies without client `Content-Length` buffered into the HTTP/1.1 upstream contract, authority rejection, encoded slash and dot-segment rejection, network-path rejection, and forwarded-header ownership. HTTP/2 cannot express HTTP/1 transfer-encoding ambiguities, so those cases remain in the raw HTTP/1 lane.

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

The nginx template returns `404` for the configured metrics path. A local collector should scrape the private `127.0.0.1:3000` upstream directly. The container template leaves metrics disabled by default because its `0.0.0.0:3000` listener may be published directly.

The CLI can emit request outcome access logs to stderr:

```sh
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --access-log plain
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --access-log json
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --action-log plain
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --action-log json
cargo run -p ferrite-cli -- serve --project /srv/app --artifact .ferrite/build --metrics-path /__ferrite/metrics
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

Application code may expose an expected public action failure by throwing `FerriteActionError` from `@ferrite/runtime/server` with a stable uppercase code and a nonempty user-safe message. Any other thrown value fails the renderer and returns generic production `500` HTML. Detailed subprocess errors are written to server stderr and must be treated as potentially sensitive operational logs. Version-1 error packets without a code remain accepted for compatibility, but new application code should always use the typed error.

## Known Gaps

- No npm packages are published yet.
- The GitHub remote and PR path exist, but hosted Actions has not yet produced job-level CI proof; exact-SHA local receipts remain the current executable evidence.
- Native prebuild artifacts have local and workflow dry-run proof, but not hosted-runner proof from this checkout.
- The production CLI exposes the main request/render/write limits, server-action CSRF cookie binding, server-action trusted-proxy public-origin checks, trusted forwarded client-IP log policy, stderr request access logs, stderr action audit logs, and an in-memory Prometheus text metrics endpoint, but not tracing sinks or external audit sinks.
- First-pass container, systemd, and nginx templates exist with local static verification; the self-contained Docker harness builds a clean exact Git archive into the artifact-only production image and runs 43 raw HTTP/1 TLS cases, seven negotiated HTTP/2 cases, five proxy-level no-upstream framing checks, nine proxy-level no-upstream malformed-target checks, and fail-closed controls against official nginx 1.29.3 selected by immutable index digest. No official container image, Helm chart, managed platform adapter, or hosted staging proof exists yet.
- There is no first-class tracing integration or external metrics sink beyond the in-memory Prometheus text scrape endpoint.
- Artifact-backed dynamic HTML, payload, action, asset, integrity-failure, source-removal, strict request framing, overlapping-request, bounded sustained mixed-load, concurrent slow-reader, controlled saturation/recovery, and failed-subprocess/next-request paths have local automated proof. Long-duration hosted capacity, host-process supervisor recovery, and hosted rollback behavior are not yet proven.
- Direct replacement of an existing build directory has a brief activation window even though failed activation attempts restore the previous directory when rollback succeeds. Production rollout should build a fresh versioned directory or image and atomically switch an external release pointer.
- Production sockets have request-read and whole-response-write deadlines plus bounded admission, with local stalled-reader proof. Sustained slow-reader load behind the real proxy remains unproven.
- Local nginx framing parity is proven for the immutable exact-commit build context, recorded Git tree, resolved platform image, and candidate build produced by the harness, including client-side chunked actions, proxy-level no-upstream rejection for five ambiguous framing probes and nine malformed-target probes, authority rejection, mandatory Ferrite log evidence, and handled-path cleanup. Mutable candidate base tags, native Windows execution, Linux amd64 CI execution, the exact hosted proxy image, real TLS chain, CDN behavior, restart, and rollback remain proof gaps until those paths run.
- The server-payload contract is Ferrite-owned and not React Flight-compatible.
