# Milestone 058 Plan: Native Prebuild Checksums

Goal: add checksum manifests and verification to the native prebuild package path so `@ferrite/node` can reject tampered or incomplete optional native packages.

Scope:

- Generate a `ferrite-node.sha256.json` manifest beside each generated `ferrite-node.node` prebuild artifact.
- Export the checksum manifest from generated optional platform packages.
- Verify checksum manifests before loading optional platform prebuilds.
- Keep explicit `FERRITE_NODE_BINDING` and local source-build resolution unchanged.
- Add resolver tests for valid prebuild checksums, missing checksum manifests, mismatched digests, and malformed checksum manifests.
- Update docs and proof notes to remove checksum verification from the missing-work list.

Out of scope:

- Publishing platform packages.
- Multi-platform CI release automation.
- Code-signing or notarization.
- WASM bindings.
- Flight-compatible server component transport.
