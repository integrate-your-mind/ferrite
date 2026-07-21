# Ferrite developer preview site

This is the private, source-backed Ferrite showcase. It documents the current
Rust-first framework experiment and embeds real captures from the
`examples/docs-workbench` artifact-backed serve.

## Run locally

Requirements: Node.js 22.13+ and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by vinext. The site is owner-only when deployed
through ChatGPT Sites; it is not a public Ferrite demo or production
deployment.

Set `FERRITE_SITE_ORIGIN` to the site's verified public HTTP or HTTPS origin
when deploying. It is not a secret. The value must contain only the origin,
without credentials, a path, query, or fragment. When it is unset, canonical
and social metadata use `http://localhost:3000`; request `Host` and proxy
headers are deliberately ignored.

## Validate

```bash
npm run lint
npm test
npm audit --audit-level=high
```

`npm test` builds the site and checks the rendered HTML, metadata, source
hygiene, navigation anchors, accessibility structure, and required real-demo
asset paths and digests.

The site does not use a database. Unused starter D1/Drizzle files and packages
were removed, and the remaining build dependencies were advanced to patched
compatible releases before the zero-vulnerability audit.

## Evidence

The screenshots in `public/demos/` were captured from the source-built Ferrite
Docs Workbench app at exact demo head
`8716f30c83b9e4fc0835c2f37f9c00bd26e8152d`. See
`public/demos/capture-manifest.json` for routes, viewports, and hashes, and
`public/demos/CAPTURE_RECEIPT.md` for the sanitized capture procedure and
source checks.

The page reports local proof only: full lint/typecheck/build/test and the
ferrite-dev-server coverage report completed, alongside ten repository Chrome
scenarios plus the exact demo browser run. No coverage threshold was enforced.
The page deliberately omits one coverage
percentage because the prior PR #4 receipt and the exact-head rerun report
different scopes. Hosted Actions remains unavailable because it fails during
startup before job allocation. Cargo release verification passes with warnings
that workspace manifests still need repository/homepage/docs metadata.

## Content boundaries

- Features are labeled Available, Partial, Experimental, or Planned.
- There is no live Ferrite URL, registry install path, or public-production
  claim.
- No secrets, tokens, private URLs, or personal data belong in this site.
- Keep demo captures tied to their exact source revision; do not replace them
  with mock screenshots.
