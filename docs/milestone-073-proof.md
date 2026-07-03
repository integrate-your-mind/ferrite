# Milestone 073: Browser Payload Navigation Proof

Date: 2026-07-03

## What Changed

- Added `test/browser-payload-navigation.test.mjs`, a Chromium-backed integration test for the public DOM payload navigation runtime.
- The test bundles a browser entry with esbuild against the real `@ferrite/runtime` and `@ferrite/protocol` packages.
- The fixture serves real HTTP JSON server-payload responses and line-delimited server-payload stream-frame responses.
- The browser proof covers same-origin prefetch intent, cached prefetch consumption on navigation, document title reconciliation, browser URL updates, stream-mode navigation, observable shell fallback before a later chunk frame, and final chunk application.

## Proof

- `pnpm test:browser`: passed with:
  - `server payload navigator handles prefetch and stream navigation in Chromium`
  - existing generated server-action form enhancement proof
  - existing protocol WASM browser bundling proof

## Remaining Gaps

- This proves payload prefetch/navigation and stream-frame application in a real browser. It does not yet cover every hydration mismatch, popstate restoration, pointer/focus edge, malformed payload failure, or browser history rollback path in Chromium.
- Remote CI is still unproven because this checkout has no configured Git remote.
