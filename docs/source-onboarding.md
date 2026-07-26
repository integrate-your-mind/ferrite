# Source onboarding

Ferrite's supported end-to-end developer-preview entry point is a source
checkout. The portable npm prerelease is limited to protocol, protocol-WASM,
and runtime packages; it does not distribute the Rust CLI or a registry-only
`ferrite init` workflow.

## Prerequisites

- Git and registry network access
- rustup with Rust 1.95, Cargo, rustfmt, clippy, and the `wasm32-unknown-unknown` target; crate metadata retains Rust 1.85 as the minimum supported compiler
- A platform compiler/linker supported by Rust
- Node.js 22 or newer; Node 24 is the repository default
- Corepack and pnpm 11.7.0

Chromium is needed for browser proof. Docker is needed only for nginx/container proof.

## Clean source setup

From the repository root:

```sh
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
corepack enable
pnpm install --frozen-lockfile
cargo build --workspace
pnpm build
```

These commands build the Rust workspace, TypeScript protocol/runtime packages, protocol WASM, and the local Node native binding.

## Create an application

Choose a target outside the Ferrite checkout. Its parent must already exist, and the target itself must be absent.

```sh
pnpm starter:create -- ../my-ferrite-app
cd ../my-ferrite-app
npm run dev
```

The starter command performs one fail-closed transaction:

1. validates the target and source-built CLI before changing the target;
2. builds release-shaped npm candidates with no `private` or `workspace:*` fields;
3. initializes the TypeScript application in a private sibling staging directory;
4. copies only `@ferrite/protocol`, `@ferrite/runtime`, and the CLI into `.ferrite-source/`;
5. rewrites dependencies to durable target-local `file:` tarball paths;
6. installs with lifecycle scripts disabled; and
7. runs the real Ferrite/TypeScript check; and
8. revalidates target absence and publishes the complete staged directory with an operating-system no-replace rename.

`.ferrite-source/`, `.ferrite/`, and `node_modules/` are ignored. Before publication, failures remove only the private staging directory and do not clean the user target. A target that appears during creation causes the exclusive publication step to fail without replacing or deleting it.

## Normal workflow

```sh
npm run check
npm run dev
npm run build
npm run start -- --once --request-path /
```

`npm run start` fails before `npm run build` because production serving requires a validated immutable artifact. That failure is expected and covered by the package verifier.

## Package boundary

| Package | Release-shaped proof | Current limit |
| --- | --- | --- |
| `@ferrite/protocol` | Packed, installed, imported, and protocol API checked | Not published |
| `@ferrite/protocol-wasm` | Packed WASM instantiated; valid input accepted and invalid input rejected | Not needed by the minimal starter; not published |
| `@ferrite/runtime` | Root and all public subpath exports imported; starter check/build/serve exercised | Not published |
| `@ferrite/node` | Installed with the current host's native prebuild and used for real render success/failure | Other platforms require their own hosted proof; not published |
| Current native prebuild | Metadata, file set, checksum, install, resolution, and native load verified | Only the current host artifact is built locally |

Source package manifests stay `private: true` and retain workspace dependencies. The verifier stages separate release manifests, rewrites internal versions, checks metadata and file allowlists, creates tarballs, and installs those tarballs together. It does not publish them.

## Troubleshooting

- Registry `404` for `@ferrite/runtime`: use `pnpm starter:create`; direct registry installation is not available.
- `ferrite: command not found`: the registry-shaped skeleton expects a distributed CLI. A source-backed starter uses `.ferrite-source/run-ferrite.mjs` instead.
- Missing Corepack: install Corepack for your Node distribution, then rerun `corepack enable`.
- Missing Chromium: run `pnpm exec playwright-core install chromium` in the Ferrite checkout and set `FERRITE_BROWSER_EXECUTABLE` as shown in the README.
- Existing target refusal: choose an absent path. Ferrite will not replace an existing file, directory, or symbolic link.

## Unproven release surfaces

- npm, Cargo, CLI, native-prebuild, and container publication
- registry-backed installation on a clean external machine
- native artifact loading on every advertised platform
- exact-pushed-SHA execution on the dedicated local Buildkite agent
- Linux, Windows, and Intel macOS execution outside the local arm64 lane
- hosted deployment, public edge support, or a production SLA
