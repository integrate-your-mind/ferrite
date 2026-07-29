# Structured Observability

Ferrite's structured observability contract is experimental. It provides
bounded, privacy-conscious JSON Lines for build and production-server
operations. It does not provide distributed tracing, a vendor exporter, an
audit ledger, or a delivery guarantee.

The feature is opt-in:

```sh
ferrite build --project ./app --event-log json
ferrite serve --project ./app --artifact .ferrite/build --event-log json
```

Events are written to stderr. Normal command output remains on its existing
stream, and omitting `--event-log` creates no structured-event writer.
`--event-log` cannot be combined with the PII-bearing legacy `--access-log` or
`--action-log` streams. Startup and user-facing diagnostics can still share
stderr, so consumers must select records by the `ferrite.observability` schema
rather than treating every stderr line as structured JSON.

## Version 1 Contract

Every event uses the fixed schema name `ferrite.observability` and version `1`.
The event vocabulary is defined by Rust enums rather than arbitrary labels.
The following is an illustrative shape, not a captured production event:

```json
{
  "schema": "ferrite.observability",
  "version": 1,
  "event": "operation_completed",
  "emitted_at_unix_ms": 1780000000000,
  "correlation_id": "0123456789abcdef0123456789abcdef",
  "sequence": 3,
  "component": "transport",
  "operation": "response_delivery",
  "outcome": "success",
  "duration_ms": 17,
  "http": {
    "method": "GET",
    "status": 200,
    "route_pattern": "/posts/:id",
    "response_mode": "document"
  }
}
```

The fixed fields are:

- `event`: `operation_started` or `operation_completed`
- `component`: `builder`, `server`, `renderer`, `navigation`, or `transport`
- `operation`: build, HTTP request, document render, navigation render, stream
  render, or response delivery
- `outcome`: `success`, `error`, `cancelled`, `timeout`, or `disconnected`
- `error_class`: a bounded class such as `invalid_input`, `rejected`,
  `resource_exhausted`, `dependency`, `protocol`, `io`, or `internal`
- `failure_phase`: `read`, `render`, `write`, or `build`
- `http`: method class, status, trusted route pattern, and response mode
- `build`: a bounded route count when a successful build reports one

Start events omit terminal outcome fields. Successful completion events omit
error fields. Durations are capped at 24 hours, build route counts at one
million, route patterns at 256 UTF-8 bytes, and each serialized event at 1 KiB.
For correlated server events, `duration_ms` is elapsed time since Ferrite began
handling the request, not a component-local span duration. Sequence numbers
describe ordering only; they do not turn these records into tracing spans.

## Correlation Boundaries

A build invocation receives one process-local correlation ID and emits a start
and terminal event. A parsed production GET or POST receives one process-local
correlation ID shared by its server, render or navigation, and transport
events:

1. sequence `0`: accepted HTTP operation started
2. sequence `1`: matching render or navigation operation completed
3. sequence `2`: application response completed
4. sequence `3`: the local socket write completed or failed

Protocol rejections and unsupported methods can begin after request parsing has
already failed, so they may emit only terminal server and transport events.
Direct Rust `handle_get` and `handle_post` calls have no socket delivery event.
A successful local write does not prove that the remote client received,
processed, or retained every byte.

Correlation IDs are opaque, process-local labels. Ferrite does not accept or
propagate an inbound correlation header, create spans, implement W3C Trace
Context, correlate browser navigation with server work, or provide a
distributed-tracing guarantee.

## Privacy And Cardinality

Structured events intentionally omit:

- raw URLs, dynamic path values, query strings, and fragments
- request and response headers
- request bodies, form values, CSRF tokens, and replay nonces
- submitted action IDs and submitted route values
- client IP addresses
- child stdout or stderr, stack traces, error strings, argv, and source paths
- user-defined labels or unbounded maps

HTTP events contain a router-owned route pattern when one is available and
`[unmatched]` otherwise. `RoutePattern::new` removes control characters and
enforces the byte limit, but embedders must still pass a trusted template
rather than a raw request value.

This contract applies only to structured events. Other command diagnostics can
still include source paths or user-facing child-process errors. It is not a
claim that the entire process stderr stream is redacted.

The older `--access-log` and `--action-log` flags remain compatibility
interfaces. They retain raw request paths, submitted action identifiers and
routes, and derived client IP addresses because the nginx framing proof uses
those fields to verify proxy ownership and canary non-delivery. Treat those
streams as sensitive, protect collector access, and avoid putting secrets in
URLs. Their privacy boundary is narrower: they omit request headers, bodies,
form contents, CSRF tokens, and replay nonces, but they are not covered by the
structured event redaction guarantee.

The Rust request and action observer APIs expose the same compatibility fields
to the embedding application.

## Backpressure And Cleanup

The CLI uses a bounded 256-event channel and a dedicated stderr writer thread.
Request and build paths use non-blocking `try_send`; they do not wait for the
consumer. A full or disconnected channel drops the event. Rust embedders can
inspect `EventEmitter::dropped_count`, but the CLI does not yet export a
dropped-event metric.

The CLI closes the sender and joins its writer thread during normal command
cleanup. If stderr itself remains blocked, shutdown stops waiting after 100 ms
and detaches that writer rather than hanging the command indefinitely. This is
best-effort operational telemetry, not a lossless audit channel.

## Rust Embedding

Rust callers can create a bounded channel from
`ferrite_core::observability::bounded_channel`, drain its receiver on an
owned thread, and attach the emitter with
`ProductionProject::with_observability_emitter`. Build callers can use
`ferrite_builder::build_project_with_observability`.

The existing `build_project` entry point, `BuildConfig`,
`ProductionServerConfig`, and `DevResponse` shapes are unchanged. Disabling the
feature requires only omitting the emitter or CLI flag.

## Known Limits

- Overload-pool `503` responses are not yet emitted through the structured
  event channel.
- Build events cover the whole build, not each renderer or bundler subprocess.
- Renderer and bundler processes created by a production build do not have a
  build-wide timeout guarantee.
- Response error classification is intentionally coarse where exposing an
  underlying child error would require retaining sensitive diagnostic data.
- Renderer, navigation, server, and transport durations are request-relative;
  Ferrite does not yet measure component-local spans.
- A stream-render event describes the selected response mode; it does not prove
  that server rendering itself was incremental.
- There is no sampling policy, exporter SDK, persistent spool, metrics bridge,
  browser correlation, or external trace backend.
- The channel is process-local and best-effort. It is unsuitable as the sole
  source for billing, security audit, or compliance records.

Treat this surface as `Experimental` until exact-head runtime, coverage, and
external integration proof are current for a release candidate.
