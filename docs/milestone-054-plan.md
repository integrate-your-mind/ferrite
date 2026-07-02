# Milestone 054 Plan: Production Observability And Render Timeouts

## Goal

Add production-facing render timeout controls and request observability hooks so long-running `ferrite serve` deployments can fail slow render work explicitly and record request outcomes.

## Scope

- Add an optional page-renderer command timeout in Rust, enforced around Node renderer subprocesses.
- Wire production serving to a configurable per-render timeout and return `504 Gateway Timeout` for renderer timeouts.
- Add production request observation events that include method, path, response status, route pattern, and elapsed duration.
- Expose the production render timeout through `ferrite serve`.
- Add tests for timeout behavior, observer events, builder clamps, and existing production success paths.

## Out Of Scope

- Full tracing backend integration.
- Structured log emission from the CLI.
- Graceful shutdown orchestration.
- Async runtime or worker-pool reuse.
- Client bundler timeout controls.
- Flight wire-format compatibility.
- Server actions.

## Required Proof

- Focused renderer and dev-server tests for timeout enforcement and production observer events.
- Focused CLI test for serve timeout flag plumbing.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
