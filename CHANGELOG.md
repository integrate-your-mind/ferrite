# Changelog

## Unreleased

No user-facing changes yet.

## 0.1.0-alpha.0 - 2026-07-26

### Added

- Rust-owned routing, rendering, protocol validation, artifact construction,
  and bounded production serving.
- TypeScript JSX, DOM, server, and protocol-facing APIs.
- Source-build examples and the portable `@ferrite/protocol`,
  `@ferrite/protocol-wasm`, and `@ferrite/runtime` npm prerelease set.

### Security

- Strict private-upstream HTTP framing, artifact integrity checks, request and
  response deadlines, bounded admission, server-action origin, CSRF, and replay
  controls, plus audit and metrics hooks.

### Known limits

- No supported public CLI distribution, complete native package matrix,
  managed hosting, or production support commitment.
- Registry availability, hosted Buildkite evidence, and provenance must be
  confirmed by the release receipt for the exact published commit; this
  changelog entry alone is not publication proof.
- Ferrite is not a drop-in React or Next.js replacement, and compatibility is
  intentionally incomplete and experimental.
