# Contributing to Ferrite

Thank you for helping improve Ferrite. This project is open source under the MIT License.

## How to contribute

- Open an issue before large changes so discussion happens early.
- Keep PRs small and focused.
- Include reproduction instructions for bugs and test notes for fixes.
- Add/update tests for normal, error, and edge paths whenever behavior changes.
- Keep changes scoped and explicit; avoid unrelated refactors.

## Local setup

From the repo root:

```sh
pnpm install
cargo build --workspace
pnpm build
pnpm lint
pnpm test
```

The website demo lives in `website/` and the framework source is in `crates/` and `packages/`.

## PR checklist

- [ ] Includes a short summary of what changed and why.
- [ ] Includes verification steps (what was run and what passed).
- [ ] Marks known risks and known gaps.
- [ ] Adds/updates tests for behavior changes.
- [ ] No secrets or credentials committed.
- [ ] Update README/docs or website if behavior changed.
