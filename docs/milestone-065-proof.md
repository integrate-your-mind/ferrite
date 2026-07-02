# Milestone 065 Proof: Server Action Form Enhancement Helper

## What Changed

- Added `enhanceServerActionForms()` to `@ferrite/runtime/dom`.
- The helper listens for submit events under a caller-provided event root and only intercepts same-origin `POST /_ferrite/action` forms that include non-empty `__ferrite_action` and `__ferrite_route` metadata.
- Enhanced submissions use browser `FormData`, preserve the clicked submit button's `name=value`, default to `credentials: "same-origin"`, validate returned `server-action-response` JSON through the shared protocol validator, and report validated responses or failures through callbacks.
- Redirect action responses call `window.location.assign()` after caller response handling.
- Plain non-action forms, malformed action forms, cross-origin forms, and destroyed listeners fall back to normal browser behavior.

## Normal Path Proof

- The focused DOM test first failed before implementation because `@ferrite/runtime/dom` did not export `enhanceServerActionForms()`.
- `pnpm --filter @ferrite/runtime build`: passed after implementation.
- `node --test --test-name-pattern "server action form enhancer" packages/runtime/test/dom.test.mjs`: passed 2 focused tests.
- `pnpm --filter @ferrite/runtime test`: passed 123 runtime tests.

## Failure Path Proof

- `server action form enhancer reports invalid action responses` proves an invalid JSON shape is not accepted as success; the helper validates the response through `validateServerActionResponse()` and reports the validation error through `onError`.
- Non-OK HTTP responses and malformed JSON are handled by the same error path.

## Odd Path Proof

- `server action form enhancer submits Ferrite action forms through validated fetch responses` also proves a plain `POST /contact` form is not intercepted.
- The same test proves `destroy()` removes the delegated submit listener and prevents later enhanced submissions.

## Full Local Gate

- `pnpm lint`: passed.
- `pnpm typecheck`: passed, including `ferrite check --project examples/basic`.
- `pnpm build`: passed.
- `pnpm test`: first sandboxed run failed only when local TCP socket tests attempted to bind/listen with `Operation not permitted`; rerunning the same command outside the sandbox passed.
- `pnpm test:release`: passed 10 verifier tests.
- `pnpm release:verify:npm`: first sandboxed run failed when npm could not write logs under the user home directory; rerunning the same command outside the sandbox passed and packed `@ferrite/protocol`, `@ferrite/protocol-wasm`, `@ferrite/runtime`, and `@ferrite/node`.
- `git diff --check`: passed.

## Not Proven

- Static server-action manifests.
- Automatic `"use server"` discovery.
- Deployment-stable action ids or persistent action registries.
- Automatic app bootstrap wiring for the helper.
- Real browser-engine proof in Chromium, WebKit, or Firefox; the current helper proof uses `happy-dom`.
- CSRF/origin/session/auth integration beyond same-origin fetch defaults.
- Upload streaming or file-part support.
- Client event actions outside form submissions.
- Remote CI, push, or pull request proof from this checkout.
