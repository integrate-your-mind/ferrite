# Milestone 037 Proof: Native Node SSR Binding

## Changed

- Added the `ferrite-node` Rust crate as a `cdylib`/`rlib` workspace member.
- Exported a minimal Node-API addon function, `renderJsonToHtml(input)`, backed by `ferrite_ssr::render_json_to_html`.
- Added `@ferrite/node` with `index.js`, `index.d.ts`, native copy script, and Node tests.
- Wired `@ferrite/node` into the root `build`, `test`, and `lint` scripts.

## Why

The framework already had a Rust-owned render protocol and SSR implementation, but JavaScript consumers still reached Rust mainly through CLI/process boundaries. This milestone adds the first real native JavaScript consumer boundary while keeping the API intentionally narrow and tied to the existing versioned render packet contract.

## Proof

- `pnpm --filter @ferrite/node test`
- `cargo fmt --all && cargo test -p ferrite-node && cargo clippy -p ferrite-node --all-targets -- -D warnings && pnpm --filter @ferrite/node typecheck && pnpm --filter @ferrite/node build && pnpm --filter @ferrite/node test`
- `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`

The first test run reproduced a native crash in the error path. The cause was an incorrect `napi_create_type_error` declaration using a C string where Node-API expects a JavaScript value. The fix switched to `napi_throw_type_error`, and the focused test then passed.

The first full gate failed Clippy because the exported unsafe Node-API entrypoint did not document its safety contract. The fix added a `# Safety` section for `napi_register_module_v1`, then the focused native gate and full repository gate passed.

Passing focused test coverage:

- Compact `render-packet` input renders through the native addon.
- Legacy serialized node input still renders through the native addon.
- Invalid packet versions throw native errors instead of crashing.
- Non-string arguments throw native type errors instead of crashing.

## Not Proven

- This is a local native addon build, not a published package with prebuilt binaries.
- There is no WASM/browser-safe package yet.
- The binding exposes SSR only; it does not execute TSX page modules or replace the current Node/esbuild page runner.
