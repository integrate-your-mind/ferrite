# Ferrite migration scanner (experimental)

This is the first, deliberately read-only slice of a proposed migration system.
It inventories a React or Next.js project and writes a deterministic **dry-run
plan**. It does not alter the target, install dependencies, call a model, create
a branch, or open a pull request.

```sh
node tools/ferrite-migrate/scan.mjs --project /path/to/react-app --output plan.json
```

`--output` must resolve outside the scanned project. This includes paths that
enter the project through a symbolic link; the scanner rejects them before it
creates directories or writes a report.

The JSON report names its compatibility tier, observed facts, proposed future
workflow steps, and manual blockers. A `TIER_1_STRUCTURAL` report is an
automation candidate only: no migration is called automatic until a future
isolated transform passes install, typecheck, unit/integration, build, browser,
and rollback gates on the exact target revision.

## Compatibility tiers

| Tier | Meaning |
| --- | --- |
| `TIER_1_STRUCTURAL` | Function-component/TSX-shaped application with no detected migration blocker. Candidate for a future reviewed transform. |
| `TIER_2_ASSISTED` | A known adapter or human choice is needed, such as a client router. |
| `TIER_3_MANUAL_REVIEW` | Framework semantics need deliberate migration work, such as Pages Router data functions, API routes, middleware, custom Next config, class components, or dynamic module loading. |
| `TIER_4_UNSUPPORTED` | The scanner found an explicitly unsupported/runtime-coupled pattern. No transform plan is emitted without an adapter. |

The scanner is conservative and pattern-based. Absence of a finding is not a
compatibility guarantee. It intentionally marks uncertain work as a blocker
instead of synthesizing a rewrite.

## Intended full pipeline (not implemented here)

`scan -> dry-run plan -> isolated worktree transform -> install/typecheck/tests/build/browser parity -> performance comparison -> focused PR`

Future transforms must preserve the original checkout, use an isolated branch,
record exact source/revision evidence, annotate every manual change, and offer a
rollback by removing the isolated worktree/PR rather than modifying the source
checkout in place.
