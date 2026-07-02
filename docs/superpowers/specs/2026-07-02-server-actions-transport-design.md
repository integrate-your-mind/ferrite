# Server Actions Transport Design

## Purpose

Milestone 062 starts Ferrite's server-action story. The current framework can render server-first routes, proxy imported `"use client"` modules into client-reference islands, and expose validated server-payload JSON/stream responses. It does not yet have a mutation path where a client or progressive-enhanced form can invoke a server-owned function and receive a validated result.

This milestone adds the first server-action transport slice, not full React Flight compatibility. The goal is to make action references explicit, serializable, validated by the Rust protocol crate, and invokable through dev and production HTTP adapters for form submissions.

Current React and Next.js docs establish the target shape: `"use server"` marks server functions, a framework creates a server reference that can be passed to client components or form `action` props, forms submit `FormData`, and server-side code must perform its own authorization checks. Ferrite should follow the shape where it is useful, while keeping the protocol Rust-owned and small enough to prove locally.

## Scope

In scope:

- Add a Rust-owned `server-action` protocol marker, version, action reference payload, action invocation request, and action invocation response.
- Generate matching TypeScript protocol types, builders, and validators from `ferrite-protocol`.
- Add a TypeScript server facade API for creating action references from server-rendered code.
- Render action references into forms as deterministic POST endpoints and hidden metadata, without executing arbitrary client-provided function names.
- Add dev and production HTTP handling for Ferrite action POSTs.
- Support `application/x-www-form-urlencoded` and `multipart/form-data` form submissions up to existing request-size limits.
- Execute only registered action ids from the current route render context.
- Return a validated action response with either JSON result data, redirect intent, or a fresh server-payload packet for the current route.
- Add example app coverage for a progressive form action.
- Document local proof and remaining gaps.

Out of scope:

- Full React Flight wire compatibility.
- General JavaScript RPC from arbitrary client components.
- Cache invalidation primitives equivalent to `revalidatePath` or `revalidateTag`.
- Persistent action registries across deployments.
- Upload streaming or large file handling.
- Cross-origin action calls.
- Authentication helpers; user code remains responsible for authorization inside the action.
- Real npm publishing or remote CI proof.

## Approach Options

Recommended: route-scoped action registry.

Ferrite records action references while server-rendering a route, assigns stable action ids derived from module path, export/function location, and an incrementing local counter, emits form POST targets under a reserved path, and keeps an in-memory action registry for the current dev/prod process. The POST handler validates the action id against the matched route and invokes the function with parsed form data. This is the smallest slice that proves mutation transport without needing a persistent compiler database.

Alternative: manifest-backed action discovery.

Ferrite could statically scan modules for `"use server"` and emit an action manifest during build/dev. This is closer to production framework behavior but requires more compiler work before any action can run. It is better as the next milestone after the transport contract is proven.

Alternative: client-only fetch helper first.

Ferrite could expose `callServerAction(id, payload)` in the DOM runtime before forms. This is easier to test, but it misses the core React/Next ergonomic path: forms and progressive enhancement. It also risks building a generic RPC surface before the server-side safety model exists.

## Architecture

### Rust Protocol

Extend `ferrite-protocol` with:

- `SERVER_ACTION_REFERENCE_MARKER = "server-action-reference"`
- `SERVER_ACTION_REQUEST_MARKER = "server-action-request"`
- `SERVER_ACTION_RESPONSE_MARKER = "server-action-response"`
- version constants starting at `1`

Protocol types:

- `ServerActionReferencePayload`
  - `ferrite`
  - `version`
  - `id`
  - `routePattern`
  - `url`
  - optional `bound` JSON object for server-bound arguments
- `ServerActionRequest`
  - `ferrite`
  - `version`
  - `id`
  - `routePath`
  - `form`
- `ServerActionResponse`
  - `ferrite`
  - `version`
  - `status: "ok" | "redirect" | "error" | "payload"`
  - `data` for small JSON results
  - `location` for redirects
  - `message` for user-safe action errors
  - `payload` for a validated `server-payload` response

Validation should fail closed on malformed markers, unsupported versions, empty ids, unsafe paths, non-object bound data, non-string form field names, and ambiguous response variants.

### TypeScript Server API

Add a server-only helper in `@ferrite/runtime/server`:

```ts
export function createServerAction<Input extends ServerActionInput, Output>(
  options: ServerActionOptions<Input, Output>,
): ServerActionReference<Input, Output>;
```

The reference is not directly callable in the browser. During server rendering, Ferrite can serialize it into form props:

- `<form action={action}>` becomes a real POST target.
- The rendered form includes hidden Ferrite action metadata only when needed.
- Passing the action to non-form event handlers is rejected in this milestone.

This keeps the first slice form-centered. A later milestone can add client event invocation from hydrated client components.

### Render-Time Action Collection

`packages/runtime/bin/render-page.mjs` already bundles a page module and imports `@ferrite/runtime/server`. Add a render context that collects action references while rendering a page/document. The action registry output should travel beside the existing render packet/server-payload output so Rust adapters know which action ids are valid for the route.

For this milestone, ids can be deterministic inside a single route render:

```text
app/posts/[id]/page.tsx#createPost:0
```

If the function source location is not available from the runtime, the first implementation may require explicit ids:

```ts
const createPost = createServerAction({
  id: "app/posts/[id]/page.tsx#createPost",
  async run(formData) {
    "use server";
    return { ok: true };
  },
});
```

Explicit ids are acceptable for Milestone 062 because they avoid pretending Ferrite has a static action compiler before it does.

### HTTP Surface

Reserve an internal same-origin action path:

```text
/_ferrite/action
```

Required request shape:

- method: `POST`
- body: `application/x-www-form-urlencoded` or `multipart/form-data`
- action id: hidden field `__ferrite_action`
- route path: hidden field `__ferrite_route`

The handler must:

1. Enforce method and content type.
2. Reuse existing request-byte limits.
3. Parse form fields conservatively.
4. Match the route path.
5. Render or load that route's action registry.
6. Reject unknown action ids.
7. Invoke the registered action with a server-side `FormData`-like adapter.
8. Return a validated `server-action-response`.

The first response mode should return JSON. Redirect and server-payload refresh are protocol-supported but may be implemented in separate tasks if needed to keep the milestone bounded.

### Browser Runtime

Browser JavaScript is optional for the first form path. Plain HTML form submission should work against the reserved action endpoint. Add a small helper only if needed for tests:

```ts
submitServerAction(form: HTMLFormElement, options?: { fetch?: typeof fetch }): Promise<ServerActionResponse>
```

This helper should validate the server response through `@ferrite/protocol`, but progressive no-JS form submission remains the primary proof.

## Data Flow

Normal path:

1. Server renders a page containing `<form action={createPost}>`.
2. Runtime serializes the action reference into the form `action="/_ferrite/action"` and hidden fields.
3. Browser submits the form with standard POST semantics.
4. Rust dev/prod adapter parses the form, validates the action id and route path, and invokes the registered action.
5. The action returns a JSON-serializable result.
6. Rust validates and returns a `server-action-response` JSON body.

Failure path:

1. Request uses a non-POST method, unsupported content type, missing action id, oversized body, unknown action id, or mismatched route path.
2. Rust returns a clear 400, 404, 405, or 413 response without invoking user code.
3. Action exceptions return a validated error response that does not leak stack traces by default.

Odd path:

1. Duplicate action ids in one route render fail during registry construction.
2. Nested forms or non-form action prop use fails during server render.
3. File uploads are rejected with a clear unsupported-file-field error until upload handling is designed.

## Testing And Proof

Protocol tests:

- Create and validate normal action references.
- Reject malformed markers, versions, ids, paths, and ambiguous responses.
- Verify generated TypeScript protocol source matches Rust.

Runtime/server tests:

- Render a form with an action reference into a POSTable form.
- Reject action references used as arbitrary event handlers.
- Reject duplicate action ids.
- Preserve existing client-reference and server-payload behavior.

HTTP adapter tests:

- Dev server action POST normal path.
- Production server action POST normal path.
- Missing action id failure path.
- Unknown action id failure path.
- Method/content-type failure path.
- Oversized body failure path.
- Action exception returns a validated error response.

Example proof:

- Add a small form to `examples/basic` that invokes a server action and returns JSON.
- `ferrite dev --once` or a focused real HTTP test proves the form endpoint.

Full local gate:

- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Documentation Updates

Add `docs/milestone-062-plan.md` and `docs/milestone-062-proof.md`.

Update `README.md` and `docs/architecture.md` to distinguish:

- Ferrite has first server-action form transport.
- Full Flight-compatible RSC and client-side event action invocation remain future work.
- User code must perform authentication and authorization inside actions.

## Acceptance Criteria

- Action protocol markers, builders, validators, and generated TypeScript exports exist.
- Server-rendered forms can serialize a Ferrite server action into a same-origin POST.
- Dev and production adapters can handle a valid action POST.
- Failure paths reject malformed, unknown, oversized, and unsupported action requests without invoking user code.
- Example app and docs show the boundary.
- Full local gates pass.
- Remote push/PR proof remains explicitly blocked until a GitHub remote is configured.

## Next Milestone

After the form transport is proven, the next server-action milestone should add static `"use server"` module discovery and a build/dev action manifest so explicit action ids are no longer required in app code.
