# Ferrite Sites state correction

- **Inspected at:** `2026-07-26T16:42:20Z`
- **Repository head:** `8634a16928b8bdf34129aba5596f6d640ac979f4`
- **Repository:** `integrate-your-mind/ferrite`
- **Sites project:** `appgprj_6a5b984c7d4481919ec1cf6bbcbd55c8`
- **Production URL:** `https://ferrite-rust-framework.poppybyte.chatgpt.site`
- **Current access:** Public
- **Current saved version:** 2
- **Reported deployed source identifier:** `ebb8fd42c7e3ae15944fc801d0a7b01c4aaa16f3`

## Correction

The earlier site receipt described the deployment as owner-only. Read-only
Sites inspection now reports public access. The deployed source identifier is
not reachable as a commit in the Ferrite Git repository, so it does not prove
deployment provenance to the reviewed repository head.

The repository defines these website routes:

- `/`
- `/blog`
- `/blog/tic-tac-toe`
- `/blog/tic-tac-toe-3d`

Direct production requests returned:

| Route | HTTP status |
| --- | --- |
| `/` | `200` |
| `/blog` | `404` |
| `/blog/tic-tac-toe` | `404` |
| `/blog/tic-tac-toe-3d` | `404` |

The production site is therefore public but stale. It is a project-information
preview, not a current live Ferrite application demo or a supported production
endpoint.

## Boundary

No access-policy change, saved version, deployment, publication, or release was
performed during this inspection. Correcting production requires rebuilding,
saving, and deploying an exact pushed commit under separate authorization.
