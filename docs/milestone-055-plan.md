# Milestone 055 Plan: Production Worker Pool And Shutdown

## Goal

Replace production per-request thread spawning with a reusable worker pool and add a shutdown signal that stops accepting new production sockets while draining already accepted work.

## Scope

- Add a cloneable production shutdown signal/controller pair for embedders and tests.
- Add a fixed-size production worker pool sized by `max_in_flight_requests`.
- Route `ferrite serve` through the reusable worker pool.
- Add a shutdown-aware production listener entry point that uses nonblocking accept, stops accepting when shutdown is requested, drops the job queue, and joins workers.
- Keep `serve_production_listener_once` deterministic for tests.
- Add tests for worker-count clamping, multi-request handling through the pool, and graceful shutdown/drain behavior.

## Out Of Scope

- OS signal handling in the CLI.
- Async runtime integration.
- Hot config reload.
- Client bundler timeout controls.
- Flight wire-format compatibility.
- Server actions.

## Required Proof

- Focused dev-server tests for worker pool sizing, multi-request handling, and shutdown drain behavior.
- Existing production response, timeout, compression, cache, and preload tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
