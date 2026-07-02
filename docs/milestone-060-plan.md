# Milestone 060 Plan: Native Prebuild Dry-Run Release

Goal: prove Ferrite can build and validate supported native Node prebuild packages in a non-publishing release workflow.

Scope:

- Add a GitHub Actions dry-run workflow for supported native prebuild packages.
- Add a verifier script for generated prebuild package directories.
- Verify package metadata, expected files, and SHA-256 manifests.
- Upload generated packages as CI artifacts.
- Document local proof and remaining release limits.

Out of scope:

- npm publication.
- GitHub releases.
- Code signing or notarization.
- Cross-compiled native prebuilds.
- Runtime API changes.
