# Milestone 083: Deployment Templates

Date: 2026-07-03

## What Changed

- Added `deploy/systemd/ferrite.service` for a private `127.0.0.1:3000` production Ferrite process managed by systemd.
- Added `deploy/nginx/ferrite.conf` for TLS termination, proxying to Ferrite, and owning `Host`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
- Added `deploy/container/Dockerfile` for a production-shaped container runtime that runs as a non-root user and starts `ferrite serve` with request limits, CSRF, trusted-proxy origin checks, and JSON access logs.
- Added `deploy/ferrite.env.example` for runtime public-origin and CSRF configuration.
- Added `scripts/verify-deployment-templates.test.mjs` to keep the templates aligned with production serve flags and proxy header requirements.
- Updated deployment, architecture, audit, README, and GTM documentation to separate first-pass templates from hosted staging proof.

## Proof

- `node --test scripts/verify-deployment-templates.test.mjs`: passed.
- `docker build -f deploy/container/Dockerfile --target runtime -t ferrite-template-smoke:milestone-083 .`: passed.
- Container smoke with runtime `FERRITE_ACTION_CSRF` and `FERRITE_PUBLIC_ORIGIN`: passed.
  - `GET /` through `127.0.0.1:39383` returned HTTP 200.
  - The response rendered the basic example document.
  - The container emitted JSON access logs with `status: 200`.
- Full verification passed before commit:
  - `cargo fmt --all`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
  - `pnpm test:release`
  - `pnpm release:verify:npm`
  - `cargo test --workspace`
  - `cargo fmt --all -- --check`
  - `git diff --check`

## Remaining Gaps

- The templates have static verifier coverage but have not been run in a hosted staging environment.
- No official published container image exists.
- No Helm chart or managed-platform adapter exists yet.
- Remote CI, push, PR, and deployment proof remain unavailable because this checkout has no configured Git remote.
