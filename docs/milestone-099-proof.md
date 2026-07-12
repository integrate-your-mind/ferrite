# Milestone 099: Fail-closed HTTP/1.1 request framing

## Outcome

Ferrite now enforces a narrow one-request HTTP/1.1 upstream contract before routing or server-action origin checks. Ambiguous framing, parser differentials, unsupported request bodies, malformed authorities, and already-buffered pipelined suffixes fail closed.

## Production behavior

- Requires exact HTTP/1.1, CRLF line endings, an origin-form target, and one valid `Host` authority.
- Bounds request heads to 100 fields and the configured request-byte limit.
- Rejects all `Transfer-Encoding` and `Expect` request fields.
- Accepts positive request bodies only for `POST /_ferrite/action` with one decimal `Content-Length`.
- Rejects duplicate framing, content, cookie, origin, referer, and trusted-forwarding fields.
- Rejects absolute, authority, asterisk, network-path, dot-segment, malformed-percent, non-ASCII, and malformed request-line forms.
- Rejects bytes already buffered after a header-only request or declared action body.
- Adds `Cache-Control: no-store` to transport parse errors and unsupported-method responses while preserving `Connection: close`.
- Canonicalizes bracketed IPv6 authorities, numeric ports, trailing DNS dots, and default HTTP(S) ports for same-origin comparisons.

## Test validity

The first two regressions were added before the parser fix. Both failed because duplicate `Transfer-Encoding` and duplicate `Content-Length` were collapsed with last-value-wins semantics. After the framing fix, the production raw-socket test initially failed because the `400` response lacked `Cache-Control: no-store`; the shared transport response path was corrected and the test then passed.

The final suite covers valid requests, malformed grammar, duplicate and conflicting headers, transfer-coding combinations, host/port forms, default-port same-origin compatibility, unsupported bodies, deterministic buffered pipelining, and a real production socket response.

## Deployment contract

The nginx template now explicitly enables request buffering, keeps the upstream on HTTP/1.1, owns trusted forwarding fields, clears `Connection`, and strips `Expect`. The deployment, architecture, README, and GTM documents describe the same boundary.

## Boundary

This milestone does not claim a live nginx runtime, TLS/CDN deployment, client-side chunked action compatibility, hosted CI job execution, publication, deployment, or release. nginx is not installed locally, the Docker daemon was unavailable, and the bounded Colima start could not write its external configuration from this workspace sandbox. Static template verification and direct Ferrite socket proof passed; real proxy framing parity remains a hosted staging gate.

Exact commands, coverage, environment, hashes, and delivery state are recorded in `docs/proof-receipts/2026-07-12T223557Z-16aff08-local-ci.md`.
