# Milestone 070: Server Action Origin Guard

Date: 2026-07-03

## What Changed

- Dev and production server-action POST handling now checks browser-supplied `Origin` and `Referer` headers before parsing action form data.
- If the request includes a `Host` header, a present `Origin` must be an absolute HTTP(S) origin whose host matches `Host`.
- If the request includes a `Host` header, a present `Referer` must be an absolute HTTP(S) URL whose host matches `Host`.
- Cross-origin action attempts are rejected with `403 Forbidden` before the page renderer can invoke a route action.

## Proof

- `cargo test -p ferrite-dev-server action_`: passed.
- New focused tests cover same-host `Origin` acceptance, cross-origin `Origin` rejection through the dev adapter, and cross-origin `Referer` rejection through a real production socket request.

## Remaining Gaps

- This is not a full CSRF system. Ferrite still needs token/session binding, cookie guidance, replay handling, and trusted-proxy configuration before server actions should be treated as production-auth complete.
- The raw HTTP adapter compares header hosts because it does not yet have trusted scheme/proxy metadata. Deployments behind TLS termination should keep `Host` trustworthy and sanitize forwarded headers until Ferrite has explicit trusted-proxy settings.
