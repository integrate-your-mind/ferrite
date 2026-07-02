# Server Actions Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ferrite's first Rust-owned server-action form transport so a server-rendered TSX form can submit to a same-origin Ferrite POST endpoint, invoke a registered server action, and return a validated action response.

**Architecture:** Extend the Rust protocol crate first, generate the matching TypeScript protocol package, add a server-only `createServerAction()` facade, serialize action references only on `<form action={...}>`, invoke actions through `packages/runtime/bin/render-page.mjs`, and route dev/production `POST /_ferrite/action` requests through Rust request parsing, route matching, protocol validation, and the existing page-renderer subprocess boundary.

**Tech Stack:** Rust protocol validation and generated TypeScript source, serde/serde_json, Ferrite dev and production HTTP adapters, Node.js ESM render-page bridge, esbuild TSX bundling, pnpm workspace tests, cargo tests, and the existing example app.

---

## File Structure

- Modify `crates/ferrite-protocol/src/lib.rs`: add server-action markers, Rust structs, validators, and generated TypeScript helpers.
- Modify `packages/protocol/src/index.ts`: regenerate from `ferrite-protocol`.
- Modify `packages/protocol/test/protocol.test.mjs`: cover normal, failure, and ambiguous response protocol cases.
- Modify `packages/runtime/src/server.ts`: add `createServerAction()`, action render context collection, form serialization, and action invocation helpers.
- Modify `packages/runtime/src/index.ts`: export public action types when they belong on the general runtime facade.
- Modify `packages/runtime/test/render-page.test.mjs`: prove render-page action invocation against temporary TSX pages.
- Create `packages/runtime/test/server-actions.test.mjs`: focused server-rendering tests for action form serialization and misuse rejection.
- Modify `packages/runtime/bin/render-page.mjs`: add `--server-action` mode and JSON argument parsing for action requests.
- Modify `crates/ferrite-page-renderer/src/lib.rs`: add `invoke_server_action()` and typed action request/response wrappers.
- Modify `crates/ferrite-dev-server/src/lib.rs`: add request-body parsing, form parsers, `POST /_ferrite/action`, and dev/production tests.
- Modify `examples/basic/app/posts/[id]/page.tsx` or add a small nested example module: include a progressive action form.
- Create `docs/milestone-062-plan.md`: concise milestone plan.
- Create `docs/milestone-062-proof.md`: local proof, known gaps, and remote PR blocker.
- Modify `README.md` and `docs/architecture.md`: document the server-action boundary without claiming Flight compatibility.

## Contract Decisions

- Action IDs are explicit for this milestone. Use `createServerAction({ id: "app/posts/[id]/page.tsx#createPost", run })` rather than pretending Ferrite can infer stable `"use server"` export identities before an action manifest exists.
- Action execution is route-scoped. The POST handler matches `__ferrite_route`, re-renders the matched route in action mode, and invokes only an action ID registered during that render.
- Only form transport is in scope. Arbitrary client event invocation and general RPC helpers remain future work.
- Request bodies must fit existing configured byte limits. `Content-Length` is required for real HTTP action POSTs; chunked action uploads are rejected in this milestone.
- `application/x-www-form-urlencoded` and small `multipart/form-data` field values are supported. File parts are rejected with a clear 400 response until upload handling is designed.
- User code remains responsible for authentication and authorization inside action functions.

## Task 1: Add Server Action Protocol

**Files:**
- Modify: `crates/ferrite-protocol/src/lib.rs`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/protocol.test.mjs`

- [ ] **Step 1: Add failing Rust protocol tests**

Add tests near the existing client-reference and server-payload tests for:

- Creating and validating a `ServerActionReferencePayload`.
- Validating a `ServerActionRequest` with string and repeated form values.
- Validating `ok`, `redirect`, `error`, and `payload` response variants.
- Rejecting empty action IDs, unsafe route paths, malformed markers, unsupported versions, non-object `bound`, non-string form keys, and ambiguous responses with more than one variant payload.

Use this shape in the tests:

```rust
let request = ServerActionRequest {
    ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
    version: SERVER_ACTION_REQUEST_VERSION,
    id: "app/posts/[id]/page.tsx#createPost".to_owned(),
    route_path: "/posts/abc".to_owned(),
    form: BTreeMap::from([
        ("title".to_owned(), ServerActionFormValue::String("Hello".to_owned())),
        (
            "tag".to_owned(),
            ServerActionFormValue::List(vec!["rust".to_owned(), "tsx".to_owned()]),
        ),
    ]),
};
validate_server_action_request(&request).unwrap();
```

- [ ] **Step 2: Implement Rust protocol structs and validators**

Add constants:

```rust
pub const SERVER_ACTION_REFERENCE_MARKER: &str = "server-action-reference";
pub const SERVER_ACTION_REQUEST_MARKER: &str = "server-action-request";
pub const SERVER_ACTION_RESPONSE_MARKER: &str = "server-action-response";
pub const SERVER_ACTION_REFERENCE_VERSION: u64 = 1;
pub const SERVER_ACTION_REQUEST_VERSION: u64 = 1;
pub const SERVER_ACTION_RESPONSE_VERSION: u64 = 1;
```

Add serde types:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerActionFormValue {
    String(String),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionReferencePayload {
    pub ferrite: String,
    pub version: u64,
    pub id: String,
    pub route_pattern: String,
    pub url: String,
    #[serde(default)]
    pub bound: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionRequest {
    pub ferrite: String,
    pub version: u64,
    pub id: String,
    pub route_path: String,
    #[serde(default)]
    pub form: BTreeMap<String, ServerActionFormValue>,
}
```

Represent `ServerActionResponse` as a tagged Rust enum with `status` values `ok`, `redirect`, `error`, and `payload`. Reuse `ServerPayloadPacket` for the payload variant so validation composes with existing server-payload checks.

- [ ] **Step 3: Extend TypeScript protocol source generation**

In `typescript_protocol_source()`, export:

- `SERVER_ACTION_REFERENCE_MARKER`
- `SERVER_ACTION_REQUEST_MARKER`
- `SERVER_ACTION_RESPONSE_MARKER`
- version constants
- `ServerActionFormValue`
- `ServerActionReferencePayload`
- `ServerActionRequest`
- response variant types
- `createServerActionReferencePayload()`
- `createServerActionRequest()`
- `createServerActionOkResponse()`
- `createServerActionRedirectResponse()`
- `createServerActionErrorResponse()`
- `createServerActionPayloadResponse()`
- validators for all three server-action protocol values

Keep validators fail-closed and side-effect-free. Do not depend on DOM APIs or `@ferrite/runtime`.

- [ ] **Step 4: Regenerate and test protocol package**

Run:

```bash
cargo run --quiet -p ferrite-protocol --bin ferrite-protocol-codegen > packages/protocol/src/index.ts
cargo test -p ferrite-protocol
pnpm --filter @ferrite/protocol build
pnpm --filter @ferrite/protocol test
pnpm --filter @ferrite/protocol typecheck
```

Expected: all pass, and `packages/protocol/src/index.ts` is the only generated TypeScript source changed in this task.

- [ ] **Step 5: Commit the protocol contract**

```bash
git add crates/ferrite-protocol/src/lib.rs packages/protocol/src/index.ts packages/protocol/test/protocol.test.mjs
git diff --cached --check
git commit -m "feat(protocol): add server action contract"
```

## Task 2: Add Server Runtime Action References

**Files:**
- Modify: `packages/runtime/src/server.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/server-actions.test.mjs`

- [x] **Step 1: Add failing runtime tests**

Create `packages/runtime/test/server-actions.test.mjs` with tests for:

- Rendering `<form action={action}>` produces `action="/_ferrite/action"`, `method="post"`, hidden `__ferrite_action`, and hidden `__ferrite_route`.
- Existing form `method="get"` is rejected when a server action is used.
- Using a server action on `button.onClick`, `div.action`, or any non-form action prop throws during server render.
- Duplicate action IDs in one route render throw before HTML/payload output is returned.
- Existing primitive prop serialization still works for non-action forms.

- [x] **Step 2: Add public server action types**

Add server-only types:

```ts
export type ServerActionInput = {
  form: Record<string, string | string[]>;
  routePath: string;
};

export type ServerActionOptions<Output> = {
  id: string;
  routePattern?: string;
  run(input: ServerActionInput): Output | Promise<Output>;
};

export type ServerActionReference<Output = unknown> = {
  readonly $$typeof: typeof SERVER_ACTION_REFERENCE_SYMBOL;
  readonly id: string;
  readonly routePattern?: string;
  readonly run: (input: ServerActionInput) => Output | Promise<Output>;
};
```

Keep the unique symbol local to `server.ts`. Export a type guard only if render-page needs it from the same module.

- [x] **Step 3: Implement `createServerAction()`**

Validate explicit IDs with the generated protocol helper. Return a frozen reference object:

```ts
export function createServerAction<Output>(
  options: ServerActionOptions<Output>,
): ServerActionReference<Output> {
  if (typeof options.run !== "function") {
    throw new TypeError("Ferrite server action requires a run function.");
  }
  const routePattern = options.routePattern ?? currentServerActionRoutePattern();
  return Object.freeze({
    $$typeof: SERVER_ACTION_REFERENCE_SYMBOL,
    id: normalizeServerActionId(options.id),
    routePattern,
    run: options.run,
  });
}
```

If no render context exists and no `routePattern` is provided, throw with a message that server actions must be created while rendering a Ferrite route or include an explicit route pattern.

- [x] **Step 4: Add action render context**

Extend `ServerRenderContext` with:

```ts
routePath?: string;
routePattern?: string;
actions: Map<string, ServerActionReference>;
```

Add helpers:

- `withServerActionRenderContext(options, render)`
- `registerServerAction(reference)`
- `collectServerActionRegistry(context)`
- `invokeRegisteredServerAction(request)`

Use async-local render context so overlapping async renders do not leak actions between requests. Preserve the existing `withHookDispatcher()` behavior.

- [x] **Step 5: Serialize form actions only**

Before `serializeServerProps(child.props)`, detect action references:

```ts
if (child.type === "form") {
  const { props, children } = serializeServerActionForm(child.props, context);
  return { kind: "element", tag: "form", props, children };
}
```

The serializer should:

- Register the action ID in the current context.
- Force or default `method` to `post`.
- Set `action` to `/_ferrite/action`.
- Add hidden inputs for `__ferrite_action` and `__ferrite_route` before user children.
- Preserve user children and primitive form attributes.
- Reject conflicting Ferrite hidden field names provided by user code.

- [x] **Step 6: Run focused runtime tests**

Run:

```bash
pnpm --filter @ferrite/runtime build
pnpm --filter @ferrite/runtime test
pnpm --filter @ferrite/runtime typecheck
```

Expected: all runtime tests pass, including existing server-payload/client-reference coverage.

- [x] **Step 7: Commit runtime references**

```bash
git add packages/runtime/src/server.ts packages/runtime/src/index.ts packages/runtime/test/server-actions.test.mjs packages/runtime/package.json packages/runtime/tsconfig.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(runtime): serialize server action forms"
```

## Task 3: Add Render-Page Action Invocation

**Files:**
- Modify: `packages/runtime/bin/render-page.mjs`
- Modify: `packages/runtime/src/server.ts`
- Modify: `packages/runtime/test/render-page.test.mjs`

- [x] **Step 1: Add failing render-page tests**

In `packages/runtime/test/render-page.test.mjs`, add temporary app fixtures that:

- Define a page with `createServerAction({ id, run })`.
- Run `render-page.mjs --server-action <page> <props-json> <layouts-json> <conventions-json> <action-request-json>`.
- Assert the JSON response validates as `server-action-response` with `status: "ok"`.
- Assert unknown action IDs fail with a non-zero exit and no user action side effect.
- Assert thrown user action errors return a validated `status: "error"` response without stack traces.

- [x] **Step 2: Add `--server-action` mode**

Extend `knownModes`:

```js
"--server-action",
```

Parse a fifth argument as `actionRequestJson` for page mode:

```text
render-page --server-action <page-file> <props-json> <layouts-json> <conventions-json> <action-request-json>
```

Do not add document action mode in this task unless a test proves it is needed. Action execution should render the page and layouts, collect route-scoped actions, then invoke the requested action.

- [x] **Step 3: Add server invocation helper**

In `server.ts`, export:

```ts
export async function invokeServerActionFromPageModule(
  pageModule: PageModule,
  props: Record<string, unknown>,
  layouts: LayoutModule[],
  conventions: RouteConventionModules,
  request: ServerActionRequest,
): Promise<ServerActionResponse>
```

Implementation requirements:

- Validate `request` with `validateServerActionRequest()`.
- Render the page child with a server-action context using `request.routePath` and the matched route pattern when known.
- Fail if the requested action ID was not registered by that render.
- Invoke the registered `run()` function with `{ form, routePath }`.
- Return `createServerActionOkResponse({ data })` for JSON-serializable results.
- Return `createServerActionErrorResponse({ message })` for user action exceptions.

- [x] **Step 4: Prove render-page behavior**

Run:

```bash
pnpm --filter @ferrite/runtime build
pnpm --filter @ferrite/runtime test
```

Expected: action invocation tests pass and existing render modes still pass.

- [x] **Step 5: Commit render-page invocation**

```bash
git add packages/runtime/bin/render-page.mjs packages/runtime/src/server.ts packages/runtime/test/render-page.test.mjs
git diff --cached --check
git commit -m "feat(runtime): invoke server actions from render page"
```

## Task 4: Add Rust PageRenderer And HTTP POST Handling

**Files:**
- Modify: `crates/ferrite-page-renderer/src/lib.rs`
- Modify: `crates/ferrite-dev-server/src/lib.rs`

- [x] **Step 1: Add failing `ferrite-page-renderer` tests**

Add tests that write a temporary page with one server action and verify:

- `PageRenderer::invoke_server_action()` returns an `ok` action response.
- Unknown action IDs return `NodeFailed` or a typed action error without invoking user code.
- Action exceptions return a validated error response.

- [x] **Step 2: Implement `PageRenderer::invoke_server_action()`**

Add typed Rust wrappers:

```rust
pub fn invoke_server_action(
    &self,
    page_file: &Path,
    layouts: &[PathBuf],
    params: &[(String, Value)],
    conventions: &RouteConventions,
    request: &ferrite_protocol::ServerActionRequest,
) -> Result<ferrite_protocol::ServerActionResponse>
```

Build `PageProps` exactly like render methods, call `render-page.mjs --server-action`, parse stdout as `ServerActionResponse`, and call `ferrite_protocol::validate_server_action_response()` before returning.

- [x] **Step 3: Add HTTP request parsing tests first**

In `crates/ferrite-dev-server/src/lib.rs`, add tests for a small parser layer:

- `POST /_ferrite/action` with urlencoded body is parsed with duplicate keys as `Vec<String>`.
- Missing `Content-Length` for action POST is rejected.
- `Content-Length` larger than configured max returns `413`.
- Production reader preserves the body instead of stopping at the header boundary.
- Unsupported transfer encoding is rejected for action POST.
- Multipart text fields parse, and multipart file parts are rejected.

- [x] **Step 4: Extend request reading safely**

Replace the string-only request result with a request object:

```rust
struct ParsedHttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
```

Update dev and production adapters to parse the request line once, route `GET` requests exactly as before, and only read/require a body for `POST /_ferrite/action`. Keep the total header plus body size under `max_request_bytes` in production. For dev socket tests, use a bounded read path rather than the current single 8192-byte header read for action POSTs.

- [x] **Step 5: Implement form parsers**

Add dependency-free parsers in `ferrite-dev-server`:

- `parse_urlencoded_form(body: &[u8]) -> Result<BTreeMap<String, ServerActionFormValue>>`
- `parse_multipart_form(content_type: &str, body: &[u8]) -> Result<BTreeMap<String, ServerActionFormValue>>`

URL decoding must reject malformed percent escapes. Multipart parsing should accept small text fields and reject parts with `filename=` or binary content disposition.

- [ ] **Step 6: Add dev and production action handlers**

Add methods:

```rust
pub fn handle_post(&mut self, raw_path: &str, headers: &HttpHeaders, body: &[u8]) -> Result<DevResponse>
```

for both `DevProject` and `ProductionProject`. Behavior:

- Only `/_ferrite/action` is accepted for POST.
- Parse form by content type.
- Require `__ferrite_action` and `__ferrite_route`.
- Remove Ferrite metadata fields before passing user form data to the action.
- Match `__ferrite_route` against the route table.
- Build a `ServerActionRequest`.
- Invoke `PageRenderer::invoke_server_action()`.
- Return `application/json; charset=utf-8` with the validated response JSON.
- Use `400` for malformed forms, `404` for unknown routes/actions, `405` for non-POST action endpoint misuse, `413` for size failures, and `500` only for framework errors.

Production should call `observe_request("POST", raw_path, ...)` just like GET.

- [ ] **Step 7: Prove HTTP action behavior**

Run:

```bash
cargo test -p ferrite-page-renderer
cargo test -p ferrite-dev-server
pnpm --filter @ferrite/protocol build
pnpm --filter @ferrite/runtime build
pnpm dev:once
```

Expected: existing GET, payload, gzip, timeout, observer, and worker-pool tests still pass; new POST tests cover normal, failure, and odd paths.

- [ ] **Step 8: Commit Rust action transport**

```bash
git add crates/ferrite-page-renderer/src/lib.rs crates/ferrite-dev-server/src/lib.rs
git diff --cached --check
git commit -m "feat(dev-server): handle server action posts"
```

## Task 5: Add Example App And Documentation

**Files:**
- Modify: `examples/basic/app/posts/[id]/page.tsx`
- Create: `docs/milestone-062-plan.md`
- Create: `docs/milestone-062-proof.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add a progressive form example**

Add a small form to the existing posts page:

```tsx
const savePost = createServerAction({
  id: "app/posts/[id]/page.tsx#savePost",
  async run({ form, routePath }) {
    "use server";
    return {
      ok: true,
      routePath,
      title: form.title,
    };
  },
});
```

Render it as:

```tsx
<form action={savePost}>
  <label>
    Title
    <input name="title" defaultValue={`Post ${params.id}`} />
  </label>
  <button type="submit">Save</button>
</form>
```

Keep the example honest: no persistence claim, no authentication claim, and no optimistic client behavior.

- [ ] **Step 2: Add proof document**

`docs/milestone-062-proof.md` must include:

- What changed.
- Why route-scoped explicit IDs were chosen.
- Normal path proof command and result.
- Failure path proof command and result.
- Odd path proof command and result.
- What was not proven: remote CI, real PR, npm publication, Flight compatibility, static action manifest, upload streaming, auth helpers, and client event actions.

- [ ] **Step 3: Update architecture and README**

Document that Ferrite now has first form-based server-action transport only after Task 4 and Task 5 are proven. Do not imply:

- Full React Server Components Flight compatibility.
- Automatic `"use server"` discovery.
- Persistent action registries across deployments.
- Cross-origin action calls.
- File upload support.

- [ ] **Step 4: Run example proof**

Run:

```bash
pnpm build:example
pnpm dev:once
```

Then send a real local HTTP POST to the dev server test path or add a deterministic `serve_listener_once` test proving the example form endpoint.

- [ ] **Step 5: Commit docs and example**

```bash
git add examples/basic/app/posts/[id]/page.tsx docs/milestone-062-plan.md docs/milestone-062-proof.md README.md docs/architecture.md
git diff --cached --check
git commit -m "docs(actions): document server action transport"
```

## Task 6: Full Verification Gate

**Files:**
- No planned edits unless verification finds a bug.

- [ ] **Step 1: Run full local gate**

Run:

```bash
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
pnpm release:verify:npm
```

Expected: all pass locally.

- [ ] **Step 2: Check coverage validity**

Review the new tests against the acceptance criteria:

- Normal route-scoped action POST.
- Missing action metadata.
- Unknown action ID.
- Unsupported method.
- Unsupported content type.
- Oversized body.
- Malformed percent encoding.
- Multipart text fields.
- Multipart file rejection.
- Action exception response.
- Existing GET/payload behavior unchanged.

Add tests before merging if any item is not physically proven.

- [ ] **Step 3: Inspect git and remote state**

Run:

```bash
git status --short --branch
git log --oneline -8
git remote -v
```

If a GitHub remote exists, push the branch and open a PR. If no remote exists, record the blocker in `docs/milestone-062-proof.md` and the final response.

- [ ] **Step 4: Final implementation commit if needed**

Only commit verification fixes or proof doc updates:

```bash
git add <changed-files>
git diff --cached --check
git commit -m "test(actions): verify server action transport"
```

## Acceptance Criteria

- Protocol markers, Rust structs, generated TypeScript types, builders, and validators exist for server action references, requests, and responses.
- Server-rendered forms can serialize a Ferrite server action into a same-origin `POST /_ferrite/action`.
- Dev and production adapters can handle valid action POSTs through the Rust page-renderer boundary.
- Unknown, malformed, oversized, unsupported, and odd action requests fail before invoking user code.
- Action exceptions return validated user-safe error responses.
- Existing server-payload, client-reference, dev GET, production GET, gzip, timeout, observer, and shutdown behavior remains green.
- Example and docs describe the actual boundary.
- Full local gates pass.
- Push and PR are completed if a GitHub remote exists; otherwise the no-remote blocker is documented.

## Next Milestone

After this form transport is proven, the next milestone should add static `"use server"` discovery and a build/dev action manifest so explicit action IDs can be removed from normal app code.
