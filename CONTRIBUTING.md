# Contributing to Ferrite

Ferrite is an experimental developer preview. The public source is open for technical evaluation and focused contributions, but the framework does not yet offer stable APIs or production support.

## Before starting

- Search existing issues and pull requests for related work.
- Open an issue before a large feature, public API change, package split, protocol change, or deployment change.
- Keep each pull request focused on one outcome.
- Do not include credentials, personal data, private URLs, customer data, or local build artifacts.
- Report security flaws through the process in [SECURITY.md](SECURITY.md), not through a public issue.

## Development setup

Ferrite uses Rust, Node.js, TypeScript, and pnpm. Use `rust-toolchain.toml`, `.node-version`, and the root `packageManager` field as the reproducible defaults. The package manifests support Node.js 22 or newer; the primary source workflow uses Node 24.

```sh
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
corepack enable
pnpm install --frozen-lockfile
cargo build --workspace
pnpm build
```

The full browser proof also needs Chromium:

```sh
pnpm exec playwright-core install chromium
export FERRITE_BROWSER_EXECUTABLE="$(node --input-type=module -e 'import { chromium } from "playwright-core"; process.stdout.write(chromium.executablePath())')"
```

To validate the contributor-facing source starter without using unpublished registry packages:

```sh
pnpm starter:create -- ../ferrite-starter-check
```

The target's parent must exist, and the target itself must be absent. Remove the generated external fixture when the review is complete.

## Required checks

Run the checks that apply to your change before opening a pull request:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

For package or release changes, also run:

```sh
pnpm release:verify:npm
pnpm release:verify:cargo
```

For nginx, proxy, or deployment changes, run the matching checks documented in `docs/deployment.md` when your system supports them. State any check you could not run and why.

Maintainer CI uses Buildkite with a dedicated local macOS arm64 agent. The repository pipeline and trust-boundary setup are documented in [`docs/buildkite-local-ci.md`](docs/buildkite-local-ci.md). A local-agent pass does not substitute for independent review or cross-platform proof.

## Pull request rules

1. Fork the repository and create a branch from `main`.
2. Add or update tests for changed behavior.
3. Update docs when behavior, commands, public APIs, or support limits change.
4. Complete the pull request template with verification, risk, rollback, and breaking-change details.
5. Resolve review comments before merge.
6. Do not force-push after review unless needed to repair the branch; explain any rewritten commits.

Maintainers may close work that expands the framework surface without a clear user need, duplicates active work, weakens fail-closed behavior, or lacks enough proof to review safely.

## Code expectations

- Prefer clear names and small, testable changes.
- Keep Rust and TypeScript protocol behavior in sync.
- Preserve deterministic builds and bounded resource behavior.
- Treat malformed, ambiguous, or untrusted input as an explicit failure path.
- Avoid new runtime dependencies unless the change justifies their cost.
- Do not weaken security or compatibility checks only to make a test pass.

## Commit messages

Use a clear, scoped subject where practical:

```text
feat(router): reject ambiguous route shapes
fix(serve): bound response shutdown
test(runtime): cover stale navigation
docs: clarify developer preview limits
```

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
