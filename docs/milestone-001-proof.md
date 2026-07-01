# Milestone 001 Proof

Date: 2026-06-29

## What Changed

- Created a Rust workspace with `ferrite-core`, `ferrite-router`, `ferrite-ssr`, and `ferrite-cli`.
- Added a TypeScript package, `@ferrite/runtime`, with JSX runtime exports, typed VNodes, `useState` API shape, and serialization into a Rust-readable VNode contract.
- Added a sample `examples/basic` app using `app/page.tsx`, `app/layout.tsx`, and `app/posts/[id]/page.tsx`.
- Added `ferrite routes`, `ferrite check`, and `ferrite render`.
- Added automatic route type generation into `.ferrite/types/routes.d.ts`.
- Added a Node-to-Rust render fixture proving the TypeScript facade can produce serialized VNodes that Rust validates and renders.

## Why

The project needs a Rust-first engine with a JS/TS-facing library. This milestone proves the first meaningful boundary:

1. TypeScript users can write TSX against `@ferrite/runtime`.
2. Rust tooling can discover routes and generate TypeScript route types.
3. Rust can validate and render a VNode tree emitted by the JS facade.

## Verified

```sh
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
printf '%s' '{"kind":"element","tag":"bad tag"}' | cargo run -p ferrite-cli -- render --input -
```

Results:

- Rust tests passed: core normal/failure/odd rendering paths, router route discovery and malformed segment paths, SSR serialized input paths, and CLI missing-tsconfig path.
- Rust formatting passed with `cargo fmt --all -- --check`.
- Rust lint passed with `cargo clippy --workspace --all-targets -- -D warnings`.
- Rust build passed with `cargo build --workspace`.
- TypeScript runtime build and typecheck passed with TypeScript 6.0.3.
- `ferrite check --project examples/basic` generated route types and passed TypeScript checking.
- `pnpm render:fixture` rendered `<main class="shell" data-route="/"><h1>Ferrite</h1><button type="button">Count: 0</button></main>`.
- Invalid serialized HTML input failed closed with `invalid HTML tag name`.

## Not Proven Yet

- Browser DOM mounting.
- Real `useState` update scheduling.
- Event delegation.
- Hydration.
- Dev server and hot reload.
- Bundling and production output.
- Static prerendering.
- Native NAPI/WASM bridge; current SSR bridge uses JSON for clarity.
- React Server Component-style server/client component splitting.

