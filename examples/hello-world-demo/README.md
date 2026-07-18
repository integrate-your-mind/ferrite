# Ferrite Hello World Demo

This is a minimal, workspace-backed Ferrite project for trying a real Rust-first
render path. It is intentionally source-checkout based: the example runs the
CLI from this repository rather than assuming a globally installed `ferrite`
binary or a published npm package.

## Prerequisites

- Rust toolchain with Cargo (the workspace MSRV is documented in the root README).
- Node.js and the repository's package manager, after installing workspace dependencies.
- Run these commands from this directory (`examples/hello-world-demo`).

From the repository root, use the equivalent commands in the root README with
`--project examples/hello-world-demo`.

## Development loop

Install workspace dependencies once from the repository root:

```sh
pnpm install
```

Check the example's TypeScript and generated route types:

```sh
npm run check
```

Run the development server (the command stays running and watches the app):

```sh
npm run dev
```

Open `http://127.0.0.1:3000/`, edit `app/page.tsx`, and refresh to observe the
development rebuild. For a deterministic one-request check, run the CLI from
this example directory:

```sh
cargo run --manifest-path ../../Cargo.toml -p ferrite-cli -- dev \
  --project . --once --request-path /
```

## Production-shaped artifact loop

Build first. This writes the validated artifact to `.ferrite/build` inside
this example; it does not publish or deploy anything:

```sh
npm run build
```

Serve that already-built artifact with the artifact-only production adapter:

```sh
npm run start
```

The `start` command does not rebuild source files. To make a deterministic
one-request smoke check instead of starting a long-running server:

```sh
cargo run --manifest-path ../../Cargo.toml -p ferrite-cli -- serve \
  --project . --artifact .ferrite/build \
  --page-renderer ../../packages/runtime/bin/render-artifact.mjs \
  --host 127.0.0.1 --port 3000 --once --request-path /
```

`--artifact .ferrite/build` is intentionally relative to `--project .`.
Do not prefix it with `examples/hello-world-demo/` when running from this
directory, or Ferrite will look for a duplicated nested path.

## Notes

- This folder uses workspace path resolution in `tsconfig.json` so it compiles against local `@ferrite/runtime`.
- Route is at `app/page.tsx`.
- `.ferrite/` contains generated output and is ignored; it can be rebuilt at any time.
- A source checkout is required today because the CLI and runtime packages are not yet published.
