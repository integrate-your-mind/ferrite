# Milestone 072: Protocol WASM Browser Bundling

Date: 2026-07-03

## What Changed

- The generated browser client bundler now treats `.wasm` imports as file assets.
- Esbuild receives Ferrite's configured static public path, so file-loader references in generated browser JavaScript point at `/_ferrite/static/...`.
- `pnpm test:browser` now builds `@ferrite/protocol-wasm` before running integration tests.
- Added `test/browser-wasm-bundler.test.mjs`, which builds a temporary `"use client"` route importing `@ferrite/protocol-wasm/ferrite_protocol_wasm.wasm` from the real package and verifies the emitted WASM asset plus browser JS reference.

## Proof

- `pnpm test:browser`: passed.
- The first focused run failed because the emitted WASM asset was referenced with a relative `./assets/...` URL. Passing `publicPath` into esbuild fixed the generated browser reference to use `/_ferrite/static/assets/...`.

## Remaining Gaps

- This proves browser bundles can import and emit the protocol WASM package artifact. It does not switch Ferrite's DOM runtime payload/navigation validators from the TypeScript protocol package to the WASM validator.
- Remote CI and deployed CDN/proxy validation are still unproven because this checkout has no configured Git remote.
