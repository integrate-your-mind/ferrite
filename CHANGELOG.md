# Changelog

Ferrite has no published release at this candidate. The first permitted release
is the exact portable npm prerelease set documented in
`docs/npm-release.md`; the CLI and native package matrix remain separate release
units rather than hidden prerequisites for those three packages.

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
