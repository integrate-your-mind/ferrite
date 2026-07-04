# Milestone 088: Production Server-Action Replay Nonces

## Scope

- Added `ferrite serve --server-action-replay-ttl-ms <ms>`.
- Added opt-in, in-process, one-time server-action replay nonces for production action forms.
- A nonce is single-use for the rendered response; submitting one action consumes it.
- Added `__ferrite_nonce` serialization in the JS/TypeScript server renderer and Rust page-renderer bridge.
- Updated deployment templates, deployment docs, architecture docs, README, GTM plan, and the productionization checklist.

## Proof

- Runtime tests prove `serverActionReplayNonce` serializes a hidden `__ferrite_nonce` field and that app-authored hidden nonce fields are rejected as reserved Ferrite fields.
- Page-renderer tests prove Rust passes `serverActionReplayNonce` into the JS page renderer.
- Parser tests prove a fresh nonce is consumed once, reused nonces are rejected, missing nonces are rejected, expired nonces are rejected, and the nonce field is removed before user action code receives form data.
- Production adapter tests prove the first real `ProductionProject::handle_post` action with a fresh nonce succeeds and replaying the exact same body is rejected.
- CLI tests prove `--server-action-replay-ttl-ms` parses, requires `--server-action-csrf-token-env`, and rejects zero TTL values.

## Not Proven

- This is not session-bound CSRF token rotation.
- This is not distributed replay protection across multiple Ferrite processes or hosts.
- No hosted staging proxy/topology proof was run because this checkout still has no configured Git remote or hosted deployment target.
