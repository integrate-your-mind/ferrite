# Milestone 053 Plan: Production Request Hardening

## Goal

Add first-pass production request hardening so the long-running production server has bounded request reads, request read timeouts, and a capped in-flight worker loop.

## Scope

- Add production server config defaults for request read timeout, maximum request header bytes, and maximum in-flight requests.
- Use the in-flight cap in the owned production listener used by `ferrite serve`.
- Keep deterministic one-request production listener helpers available for tests.
- Return explicit HTTP errors for request read timeout and oversized request headers.
- Add tests for normal behavior, timeout behavior, oversized request behavior, and the in-flight limiter primitive.

## Out Of Scope

- Full async runtime integration.
- Per-route render execution timeout.
- Graceful shutdown orchestration.
- Worker pool reuse.
- Observability hooks.
- Flight wire-format compatibility.
- Server actions.

## Required Proof

- Focused dev-server tests for request timeout, oversized headers, limiter behavior, and existing production route behavior.
- Existing compression, chunked transfer, static asset cache, and preload header tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
