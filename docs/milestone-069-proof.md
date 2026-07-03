# Milestone 069 Proof: Browser Action Form Enhancement

## What Changed

- Added `playwright-core` as a workspace dev dependency without bundled browser downloads.
- Added `pnpm test:browser`, which builds protocol/runtime packages and runs a Chromium-backed Node test.
- Added `test/browser-server-actions.test.mjs`, which creates a temporary Ferrite app, runs the real `ferrite build` path, serves the generated static output, launches system Chrome, and clicks server-action forms.
- The browser fixture covers three generated asset paths:
  - whole-route client script bootstrap,
  - client-reference island script bootstrap,
  - standalone server-only `actionBootstrap` script.

## Normal Path Proof

- `pnpm test:browser`: passed locally with system Google Chrome.
- Each route stayed on its original URL after submit, proving the form was enhanced instead of navigating to `/_ferrite/action`.
- The test server received Chromium `FormData` submissions with the expected `__ferrite_action`, `__ferrite_route`, and `title` fields.

## Failure Path Proof

- Earlier red runs exposed two fixture issues before the final green path:
  - server-only `createServerAction()` needed an explicit `routePattern`;
  - the static test server needed multipart parsing because Chromium sends enhanced `FormData` as `multipart/form-data`.
- The final test bounds each expected action request with a timeout so a missing generated bootstrap fails as a route-specific timeout instead of hanging.

## Odd Path Proof

- The server-only route asserts the HTML includes the fingerprinted `route-server-action-action-bootstrap` script and does not include a route hydration script.
- The island route asserts the client-reference script path is present.
- The route client path asserts the route hydration script path is present.

## Not Proven

- WebKit or Firefox engine proof.
- Browser-engine proof for payload navigation, stream-frame application, popstate restoration, prefetching, focus, pointer, or history edge cases.
- Remote CI proof for the browser test; no Git remote is configured in this checkout.
- Automatic `"use server"` discovery.
- Deployment-stable inferred action ids.
- Upload streaming or file-part support.
- Client event actions.
