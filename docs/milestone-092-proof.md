# Milestone 092 Proof

## Scope

Replace source-driven production serving with a versioned immutable build artifact, remove project-wide request serialization, and prove the official production path without claiming remote or hosted evidence.

## Artifact Contract

`ferrite build` now stages a complete candidate and installs:

- `ferrite-server.json` format `ferrite-server` major `1`, minor `0`.
- One minified, self-contained server module per discovered route, including dynamic routes without `generateStaticParams`; static application dependencies and the matching Ferrite server runtime are bundled into it.
- One parameter-independent browser bundle per route pattern. Whole-route client hydration reads request props from the server-rendered `data-ferrite-page-props` value instead of embedding build-placeholder params.
- Route params, client bundle metadata, server-action ids observed during build rendering, and optional prerender-path mappings. Request-parameter registration in the verified module remains authoritative for action invocation.
- Size and SHA-256 records for every referenced server module, browser output, and prerendered HTML file.
- A build identity derived from the canonical manifest contents.

Failed staged builds leave the previous complete output in place, and failed activation restores the previous output when rollback succeeds. Replacing an existing directory is not a truly atomic release-pointer swap and has a brief activation window.

## Production Loader And Runtime

Before serving, Ferrite rejects:

- missing artifact roots or manifests,
- unknown manifest fields or incompatible format versions,
- duplicate route or file declarations,
- malformed route patterns or client public paths,
- absolute, traversal, backslash, drive-like, or non-normalized artifact paths,
- undeclared server modules, browser URLs, outputs, prerenders, or requested static files,
- missing files, size mismatches, SHA-256 mismatches, build-id mismatches, and symlink escapes.

The public production constructor and `ferrite serve` command consume artifacts. Source constructors remain test-only for legacy adapter coverage. Production retains the verified module and static-asset bytes at startup, then executes self-contained modules through `packages/runtime/bin/render-artifact.mjs` over stdin. The runner does not import esbuild, and production does not reopen artifact files, scan `app/`, write route types, discover action manifests, or run the client bundler.

Immutable artifact state is shared through `Arc<ProductionProject>`. Replay nonces use their own short-lived mutex, so rendering, payload, asset, and action execution do not hold a project-wide lock.

## Local Proof

- Builder tests cover valid loading, unknown fields/version rejection, manifest/file mutation, missing declarations, traversal, symlink escape, failed-build preservation, dynamic/catch-all builds, browser outputs, and action metadata.
- A real-runner client-bundler test proves production hydration reads `data-ferrite-page-props` and does not embed placeholder params.
- A source-removal integration test builds a dynamic route with a client island, a local application package, and parameter-conditional server actions; deletes `app/` and local `node_modules`; loads the artifact; deletes the artifact directory; then proves HTML, validated payload JSON, unconditional and conditional action success, unknown-action rejection, verified client asset serving, and undeclared-file rejection.
- A concurrency regression test uses deliberately slow artifact operations and proves two requests overlap without project-wide serialization.
- CLI tests prove `--artifact` input, rejection of source-only serve flags, and startup failure when the artifact is missing.
- Deployment-template tests require artifact build/copy/start commands and the production-only artifact runner.
- The real example builds seven server modules and serves a non-prerendered `/posts/gamma` request through `render-artifact.mjs` with request-specific metadata, action markup, and client-reference props.
- The exact container template builds and runs locally as user `ferrite`; a dynamic route, fingerprinted asset, and JSON access log pass while runtime inspection confirms workspace packages, root `node_modules`, and the app package manifest are absent.

## Explicitly Not Proven

- No Git remote, push, PR review, or remote CI run exists for this checkout.
- The container/systemd templates have not served this artifact in hosted staging behind real TLS/proxy infrastructure.
- The overlap test is not sustained load, capacity, soak, or multi-instance proof.
- Response-write deadlines and slow-reader handling remain unimplemented.
- Artifact integrity detects mutation but is not a signed provenance or authenticity mechanism.
- Direct replacement of an existing output directory is staged with rollback but is not an atomic release activation; deployments still need a versioned directory/image pointer.
- Published-package clean installation, npm/Cargo registry publication, native prebuild registry loading, and public release rollback remain unproven.
- Session-bound CSRF rotation, distributed replay storage, first-class auth integration, and external tracing/audit sinks remain open.
