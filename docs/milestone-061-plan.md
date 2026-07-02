# Milestone 061 Plan: npm Publishing Prep

Status note, July 2, 2026: milestone 063 superseded the npm verifier behavior by staging release-shaped package copies, running real `npm pack --json`, and inspecting packed manifests. This plan remains the historical milestone 061 dry-run scope.

Goal: prove Ferrite's JavaScript-facing packages can be built and inspected as npm package dry-runs without publishing anything.

Scope:

- Add locally knowable npm package metadata to public Ferrite package manifests.
- Add a verifier for package builds, release-shaped report manifests, and `npm pack --dry-run` file output.
- Verify native prebuild package release metadata.
- Add a read-only GitHub Actions npm package dry-run workflow.
- Document proof and remote publishing gaps.

Out of scope:

- `npm publish`.
- Trusted publisher setup.
- Registry tokens or secrets.
- GitHub releases or tags.
- Publishing native prebuild packages.
- Selecting a public repository URL in a checkout with no Git remote.
