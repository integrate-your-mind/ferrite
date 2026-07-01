# Milestone 038 Plan: Server/Client Reference Transport Hardening

## Goal

Move imported `"use client"` islands closer to a React Server Components-style boundary by making the server/client reference payload explicit, versioned, and validated across Rust and TypeScript.

## Scope

- Define a durable client-reference payload shape owned by Rust protocol code.
- Generate or mirror the TypeScript payload types from the Rust-owned contract.
- Validate client-reference ids, module names, export names, and serialized props before they reach HTML output.
- Cover normal, malformed, and compatibility cases in focused tests.
- Keep the existing island behavior working for the example app and production build path.

## Out Of Scope

- Full React Server Components execution.
- Flight-compatible wire format.
- Native/WASM package distribution.
- Production cache hashing or compression.

## Required Proof

- Focused Rust protocol/server-reference tests.
- Focused TypeScript runtime/server tests for valid and invalid payloads.
- Full gate: `pnpm test && pnpm lint && pnpm build && pnpm typecheck && pnpm render:fixture && pnpm dev:once && pnpm build:example`.
