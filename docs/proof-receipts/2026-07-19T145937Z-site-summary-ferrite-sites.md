# Ferrite Site proof receipt

- **Status:** Working private alpha
- **Deployment target:** Ferrite (ChatGPT Sites, owner-only)
- **Repository:** `integrate-your-mind/ferrite`
- **Audited source:** [repository root](../..)
- **Site source:** [`website`](../../website)
- **Site commit:** `906b2558b02f8a9c47bed324cc3a6c9e76a6e176` (reported by deployment metadata as pushed and matched)

## Feature labels

- Available: compiler-owned module graph, Rust SSR/routing, TypeScript developer surface
- Partial: server actions
- Experimental: production-shaped deployment
- Planned: public CLI, packages, native prebuilds, and registry distribution

## Removed / absent claims (from site statement)

- Removed unsupported claims about production readiness, complete React/Next compatibility, public installation, green hosted CI, current-head nginx proof, models, databases, adoption, testimonials, and a live demo.
- Placeholder sections are intentionally used for non-existent items:
  - Product screenshots
  - Demo recording
  - Public live Ferrite deployment

## Known limits captured in site content

- PR #4 is still draft.
- Hosted Actions still fails before job allocation.
- current-head nginx proof is missing.
- Repository still lacks public release/governance infrastructure.
- Server actions still need stronger session-bound auth and distributed replay handling.
- GitHub links require private-repo access.

## Verification claims currently recorded

- ESLint passed.
- Production build passed.
- All three rendered-site tests passed.
- Visual inspection passed at:
  - Desktop `1440×1000`
  - Mobile `390×844`
  - No horizontal overflow or clipped text found.
- Production returned HTTP 200.
- Deployed favicon and social image hashes matched committed assets.
- In-page links and section targets passed.
- Production dependency audit found no high-severity issue at the configured gate.
- Two moderate transitive PostCSS advisories remain (auto-fix is breaking downgrade).

## Explicitly missing items (intentionally represented as placeholders)

- Product screenshots
- Demo recording
- Public live Ferrite deployment

## Recommended next work

- Capture real runtime media.
- Complete licensing/governance and public packaging.
- Restore hosted CI to stable execution.
- Obtain exact-head nginx proof before flipping to public access.

## Note

This receipt captures site-level evidence and claims surfaced in the current website artifact and deployment summary.
