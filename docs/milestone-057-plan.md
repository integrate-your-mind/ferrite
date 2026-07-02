# Milestone 057 Plan: Native Prebuild Resolution

Goal: make `@ferrite/node` ready to consume platform-specific prebuilt native packages while preserving the local source-build path used by development and tests.

Scope:

- Factor native binding resolution out of `index.js` into a testable module.
- Keep `FERRITE_NODE_BINDING` as the highest-priority explicit override.
- Prefer the local source-build artifact at `dist/ferrite-node.node`.
- Fall back to supported optional prebuild packages such as `@ferrite/node-darwin-arm64`.
- Add a prebuild package generator script that copies the built native binding and writes a platform package manifest.
- Add tests for override, local build, optional prebuild, unsupported platform, and missing optional package paths.
- Update docs to describe the native prebuild resolution boundary without claiming release automation exists.

Out of scope:

- Publishing platform packages.
- Multi-platform CI release automation.
- Code-signing, notarization, or checksum verification.
- WASM bindings.
- Flight-compatible server component transport.
