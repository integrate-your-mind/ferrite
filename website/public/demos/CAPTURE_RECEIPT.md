# Ferrite Docs Workbench capture receipt

Captured at `2026-07-18T16:21:39Z` from the local Ferrite repository on branch
`codex/real-demo-examples` at exact commit
`8716f30c83b9e4fc0835c2f37f9c00bd26e8152d`.

## Source proof

- Example: `examples/docs-workbench`
- Artifact build ID: `sha256:d54c36b56cc5dff3217c8ae6dc96e907733f5da302714341b5a8413f8d8af99d`
- Server binary: `target/debug/ferrite`
- Serve boundary: loopback-only, artifact-backed `ferrite serve`
- Browser: real local Chrome controlled through `agent-browser`

Before capture, the exact source head passed:

```text
pnpm check:demos
pnpm build:demos
pnpm test:demos
```

The capture run then started the built `target/debug/ferrite serve` binary for
`examples/docs-workbench`, opened each route in Chrome at the viewport recorded
in `capture-manifest.json`, exercised the mobile menu for the hydrated state,
and stopped both the browser session and local server after capture.

## States recorded

- Normal: `/` at `1440x1000`
- Generated route: `/guides/architecture` at `1280x900`
- Odd catch-all route: `/guides/unlisted/path` at `1280x900`
- Hydrated client state: `/` with the mobile menu open at `390x844`

`capture-manifest.json` records each PNG's SHA-256 digest and pixel dimensions.
The site test recomputes those values from the committed bytes. This receipt
proves the recorded local procedure and source identity; it is not hosted CI or
a hosted Ferrite deployment receipt.
