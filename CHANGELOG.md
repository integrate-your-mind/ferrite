# Changelog

Ferrite has no published release. All entries remain under **Unreleased** until
an exact package set, CLI, native artifacts, and hosted release workflow pass
the documented release gates.

## Unreleased

### Added

- Rust-owned routing, rendering, protocol validation, artifact construction,
  and bounded production serving.
- TypeScript JSX, DOM, server, and protocol-facing APIs.
- Source-build examples and local release-shaped package verification.

### Security

- Strict private-upstream HTTP framing, artifact integrity checks, request and
  response deadlines, bounded admission, server-action origin, CSRF, and replay
  controls, plus audit and metrics hooks.

### Known limits

- No registry publication, supported public CLI distribution, successful
  hosted CI proof, hosted deployment proof, or production support commitment.
- Ferrite is not a drop-in React or Next.js replacement, and compatibility is
  intentionally incomplete and experimental.
