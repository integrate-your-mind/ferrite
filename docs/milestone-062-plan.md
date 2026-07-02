# Milestone 062 Plan: Server Action Transport Example

Goal: prove the first form-based server-action transport through the basic example and documentation without claiming unsupported React/Next parity.

Scope:

- Add a progressive form to `examples/basic/app/posts/[id]/page.tsx` using `createServerAction()`.
- Keep the action route-scoped with an explicit stable id.
- Document what the transport supports in README and architecture docs.
- Record local proof for normal, failure, and odd paths.

Out of scope:

- Persistent writes or storage.
- Authentication or authorization helpers.
- Automatic `"use server"` export discovery.
- Static action manifests.
- Flight-compatible React Server Components.
- Cross-origin action calls.
- File upload support or upload streaming.
- Client event actions outside form submissions.
