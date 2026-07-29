# Ferrite developer-preview site

This directory is a genuine Ferrite app-directory project. It uses
`@ferrite/runtime` pages, layouts, a custom `document.tsx`, and explicit
`"use client"` islands. It does not use Next, React, or vinext.

## Source-backed loop

From this directory, with the repository checkout available:

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm run prepare:runtime
pnpm run check
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm run start
```

For a source-connected Sites deployment, build from the repository root:

```bash
pnpm build:site
```

That command compiles the protocol and runtime directly, builds this app with
the Rust CLI, packages the verified artifact for Sites, and copies only the
deployable output to the repository-root `dist/` directory. It intentionally
does not invoke a package manager from inside the deployment build, because the
Sites builder may install with pnpm and execute the build through npm.

The trusted x86_64 Linux Sites source build may set
`FERRITE_SITES_BOOTSTRAP_RUST=1` when its image does not include Cargo. That
path downloads only the pinned official `rustup-init` 1.28.2 binary, verifies
its checked-in SHA-256, installs the repository's Rust 1.95.0 toolchain with the
minimal profile into an ephemeral directory, and removes the toolchain and
compilation cache after packaging. Other platforms fail closed.

The website has its own pinned `pnpm-lock.yaml`; `@ferrite/runtime` is wired as
a local link to `../packages/runtime`, so this command must be run from this
directory with the Ferrite source checkout present. The runtime's workspace
protocol dependencies are resolved by the source checkout's pnpm store.

Ferrite supports request-time server rendering, browser mounting and hydration,
and build-time prerendering. The current project is a developer preview; there
is no registry-only starter claim.
Set `FERRITE_SITE_ORIGIN` to the verified HTTP(S) production origin at build
time to bind canonical, Open Graph, Twitter, robots, and sitemap URLs. The value
is origin-only; credentials, paths, queries, and fragments are rejected. The
checked-in robots and sitemap files are templates: `package:sites` regenerates
them from the validated artifact route manifest and origin.

## Sites adapter

After a Ferrite artifact exists, `pnpm run package:sites` invokes
`deploy-adapter.mjs`. The adapter copies every declared prerendered HTML,
`_ferrite/static` bundle, and public asset (while keeping server modules out of
the public tree) into the Sites shape:

- `dist/server/index.js` — generated Node-compatible immutable-output adapter entry
- `dist/client` — browser bundles and public assets
- `dist/.openai/hosting.json` — unchanged project ID from `.openai/hosting.json`

It verifies the source manifest and every declared file (type, symlink/reparse
status, size, and SHA-256), stages and verifies a complete output, then swaps
the Sites directory transactionally with rollback. It serves generated deep
links, returns a real 404 for unknown paths, and adds conservative
cache/security headers with no request-body or query logging. The plain adapter
only serves immutable output; it does not compile Ferrite source.

The Cloudflare-hosted project site uses the verified prerendered HTML and browser
assets. It does not run Ferrite's native HTTP listener or request-time SSR inside
a Worker. A future request-time edge mode needs a dedicated fetch-based adapter.

The generated `sourceBuildId` is the verified Ferrite artifact-content identity,
not a Git commit or tree identity. Exact-source claims must also cite an external
build receipt bound to the tested commit.

## Evidence and boundaries

Screenshots in `public/demos/` are source-backed captures from
`examples/docs-workbench` at exact head
`8716f30c83b9e4fc0835c2f37f9c00bd26e8152d`. They are local evidence, not hosted
or current-head production proof. Feature status is labeled Available, Partial,
Experimental, or Planned. No drop-in React/Next, performance, coverage, or
production-readiness claim is made.
