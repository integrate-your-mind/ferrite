# Milestone 075: Browser Malformed Payload Rejection

Date: 2026-07-03

## What Changed

- Extended the Chromium payload navigation integration test with a malformed server-payload response.
- The test now calls the public `createServerPayloadNavigator().navigate()` API for the malformed route and proves the promise rejects with the compact-node validation error.
- The browser proof verifies the current URL, document title, route root, and rendered content remain on the previous route after the malformed payload rejection.

## Proof

- `pnpm test:browser`: passed with:
  - `server payload navigator handles prefetch, stream navigation, and popstate in Chromium`
  - existing generated server-action form enhancement proof
  - existing protocol WASM browser bundling proof

## Remaining Gaps

- This proves the programmatic navigation failure path for malformed payloads in Chromium. It does not yet prove malformed click fallback behavior, failed popstate fallback behavior, hydration mismatch failures, or every focus/pointer/history edge in a real browser.
- Remote CI is still unproven because this checkout has no configured Git remote.
