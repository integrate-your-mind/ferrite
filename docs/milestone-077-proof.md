# Milestone 077: Deployment Guide

Date: 2026-07-03

## What Changed

- Added `docs/deployment.md` as the first operator-facing deployment guide for Ferrite's current production adapter.
- Documented release prerequisites, production topology, build/start commands, runtime knobs, smoke tests, observability hooks, rollback expectations, and security gaps.
- Updated README, architecture, and the project status audit to point at deployment documentation without claiming deployed proof.

## Proof

- Documentation review against current commands and production adapter behavior.
- `cargo fmt --all && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:release && pnpm release:verify:npm && cargo test --workspace && cargo fmt --all -- --check && git diff --check`: passed.

## Remaining Gaps

- This is deployment documentation, not a deployed environment.
- GitHub remote, push, PR, remote CI, npm publication, hosted native prebuild proof, official containers, process manager templates, and platform adapters remain unproven.
