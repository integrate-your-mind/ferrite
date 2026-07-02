# Milestone 062 Proof: Server Action Transport Example

## What Changed

- Added a progressive server-action form to `examples/basic/app/posts/[id]/page.tsx`.
- Added an explicit `@ferrite/runtime/server` TypeScript path alias and Node types to the basic example.
- Fixed client-reference scanning so non-relative imports, such as `@ferrite/runtime/server`, cannot bleed into the next relative client-component import.
- Documented the first form-based server-action transport in README and architecture docs.

## Why Explicit Route-Scoped IDs

Ferrite does not yet have automatic `"use server"` export discovery or a static action manifest. The example therefore uses an explicit route-scoped action id, `app/posts/[id]/page.tsx#savePost`, plus `routePattern: "/posts/:id"`. This keeps the action identity readable and stable for the current transport without pretending that Ferrite can infer deployment-stable action identities yet.

## Normal Path Proof

- `pnpm typecheck`: passed; `Ferrite check passed`, `routes: 7`, `typescript: passed`.
- `pnpm build:example`: passed; `Ferrite build complete`, `routes: 7`, `html files: 9`, `skipped dynamic routes: 0`.
- `pnpm dev:once`: passed; rendered `/posts/abc` with `<form action="/_ferrite/action" method="post">`, hidden `__ferrite_action`, hidden `__ferrite_route`, and the title field.
- `cargo test -p ferrite-dev-server dev_action_post -- --nocapture`: passed; 3 dev POST tests passed.
- `cargo test -p ferrite-dev-server production_action_post_observes_real_socket_requests -- --nocapture`: passed; production POST over a real socket returned JSON and emitted a `POST` observer event.

## Failure Path Proof

- `cargo test -p ferrite-dev-server dev_action_post -- --nocapture`: passed `dev_action_post_rejects_missing_metadata_fields`.
- The same focused run passed `dev_action_post_reports_unknown_routes_and_unsupported_media_types`, covering `404` for unknown submitted routes.

## Odd Path Proof

- `cargo test -p ferrite-dev-server dev_action_post -- --nocapture`: passed unsupported media-type coverage.
- `cargo test -p ferrite-client-bundler`: passed after adding coverage for a server page that imports `createServerAction` before importing a client component.

## Full Local Gate

- `pnpm lint`: passed.
- `pnpm test`: passed.
- `pnpm build`: passed.
- `pnpm typecheck`: passed.
- `pnpm render:fixture`: passed.
- `pnpm dev:once`: passed.
- `pnpm build:example`: passed.
- `pnpm release:verify:npm`: passed; verified dry-runs for `@ferrite/protocol`, `@ferrite/protocol-wasm`, `@ferrite/runtime`, and `@ferrite/node`.
- Later local commit `c2f535e fix(runtime): flush client bundle responses` fixed the client bundle executor so route client bundle responses are flushed before process exit.
- Later local commit `efe44cc test(release): verify npm package reports` strengthened `scripts/verify-npm-packages.test.mjs` so the report test now exercises `verifyNpmPackages()` with package validation, build and pack hooks, and `npm-package-report.json` output.

## Remote State

- `git status --short --branch`: branch `codex/protocol-wasm-validation` with local working changes before this proof commit.
- `git log --oneline -8`: latest local commits now include `efe44cc test(release): verify npm package reports`, `c2f535e fix(runtime): flush client bundle responses`, `d12ceb2 feat(dev-server): handle server action posts`, and `de4c09c feat(dev-server): parse server action posts`.
- `git remote -v`: no configured remote, so no push or pull request could be created from this checkout.

## Not Proven

- Remote CI, because this checkout has no configured Git remote.
- A real pull request, for the same no-remote reason.
- npm publication.
- npm tarballs with rewritten publish manifests; the current release verifier records rewritten manifests in a report but does not stage them into real packed tarballs.
- Flight-compatible React Server Components.
- Automatic `"use server"` discovery.
- A static server-action manifest or persistent deployment registry.
- Upload streaming or file parts.
- Auth helpers.
- Client event actions outside progressive form submissions.
- A client-side progressive-enhancement helper for action metadata/bootstrap.
