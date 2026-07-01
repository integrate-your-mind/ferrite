# Milestone 047 Plan: HTTP Server-Payload Stream Frames

## Goal

Expose the `server-payload-frame` contract through dev and production HTTP adapters so the browser streaming helper can consume real framework route responses.

## Scope

- Add a reserved payload negotiation value for framed server-payload streams.
- Emit line-delimited shell and chunk frames from page/document server-payload output.
- Use a distinct content type for framed server-payload streams.
- Preserve existing `?__ferrite_payload=server` JSON packet behavior.
- Preserve dev/prod cache and route-pattern metadata.
- Add adapter tests for route payload streams, custom document payload streams, unsupported values, render failures, and real socket chunking.

## Out Of Scope

- Flight wire-format compatibility.
- Server actions.
- Scroll restoration.
- Browser navigator automatic stream-mode selection.

## Required Proof

- Focused Rust adapter tests for dev and production stream-frame responses.
- Real socket proof for framed payload stream output.
- Existing JSON payload response tests remain green.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
