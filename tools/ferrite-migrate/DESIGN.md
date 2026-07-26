# React/Next.js to Ferrite migration product design

Status: experimental design plus a read-only scanner. This is not a universal
migration promise, a codemod suite, or a GitHub App.

## Evidence and compatibility contract

Ferrite currently supplies file-system `app/` routes, layouts, dynamic and
catch-all routes, metadata, browser client islands, server actions, a Rust-owned
module graph, and a source-built `check/build/serve` path. It does **not** claim
drop-in React/Next compatibility, React Server Components parity, automatic
`"use server"` discovery, broad authentication middleware, uploads, or a public
HTTP edge. The scanner therefore treats framework-specific assumptions as
reviewable blockers rather than rewriting them optimistically.

The design follows the official migration posture:

- React's [React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
  documents targeted codemods for specific deprecated APIs, rather than a
  universal application rewrite.
- Next's [Pages-to-App Router migration guide](https://nextjs.org/docs/pages/guides/migrating/app-router)
  recommends incremental route migration, preserves the existing router during
  transition, and calls out router/data-fetching differences.
- Next's [Create React App migration guide](https://nextjs.org/docs/pages/guides/migrating/from-create-react-app)
  begins with a client-side app and names advanced configuration as additional
  consideration, not an automatic conversion.
- Next's [upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
  publishes version-specific codemods. Ferrite adapters must similarly declare
  their source/target compatibility instead of guessing from package names.

## Pipeline

1. **Inventory.** The product will read a target tree, `package.json`, source
   imports, route conventions, assets/styles/config names, and environment
   variable *names* (never values). The current scanner implements only
   `package.json`, TypeScript/JavaScript source, route/config convention, and
   selected import/API findings; it produces a deterministic JSON report.
2. **Plan.** A read-only plan groups source facts into a compatibility tier,
   candidate adapters, explicit manual blockers, and a no-mutation verification
   checklist. This slice implements steps 1 and 2.
3. **Transform.** A future AST-only transformer runs in a new Git worktree from
   the exact scanned revision. It applies versioned adapters and emits a patch;
   unknown dynamic code remains untouched and blocked.
4. **Verify.** The transformed worktree must install, typecheck, run the
   existing unit/integration suite, build, exercise a browser parity matrix, and
   compare bounded performance measurements. Every failure is attached to the
   plan, not hidden.
5. **Review/PR.** A future local CLI can generate a focused PR branch with the
   scan, applied adapter versions, exact commands, test evidence, manual
   annotations, AI attribution, and rollback: delete the isolated branch or
   worktree without modifying the source checkout. A later GitHub App may open
   the same transparent PR and request Buildkite checks; it must not claim a
   human review or run untrusted fork code on the local agent.

## Tiers and gradual adoption

`TIER_1_STRUCTURAL` is limited to simple function-component/TSX projects with
no currently detected blocker. It is only a candidate for an automated
transform. `TIER_2_ASSISTED` requires a known adapter or human choice, such as
a client router. `TIER_3_MANUAL_REVIEW` covers server data methods, API routes,
middleware, custom framework config, legacy class/DOM semantics, and dynamic
loading. `TIER_4_UNSUPPORTED` means no transformation can start without a new
explicit adapter contract.

The product should support a staged route/component migration where the existing
application continues to own unconverted pages. It must never offer a flag-day
rewrite as the only path.

## Extensibility and public proof

Adapters should use a small declarative SDK: supported source-framework range,
Ferrite target range, AST matcher, transform, risk tier, required verification
commands, rollback note, and fixture IDs. Each adapter requires deterministic
fixtures for normal, failure, and odd behavior. A public corpus should contain
small, licensed representative React and Next applications—not user projects—
with pinned inputs, expected plans/patches, test traces, and compatibility
status. Case studies may only report measured results from exact source and
commands; no migration result is a marketing claim until this proof exists.

## Interfaces

- **CLI now:** `node tools/ferrite-migrate/scan.mjs --project <path> --output <plan.json>`.
- **Codex skill/MCP later:** expose the same scan schema as a read-only tool;
  mutation requires an explicit target worktree plus recorded confirmation.
- **GitHub App later:** receives a selected repository/ref, creates a clearly
  AI-authored migration PR, and publishes Buildkite-backed results. It has no
  merge authority and must separate secrets from untrusted source execution.
