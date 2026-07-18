import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_REFERENCE_MARKER,
  CLIENT_REFERENCE_VERSION,
  SERVER_ACTION_REFERENCE_MARKER,
  SERVER_ACTION_REFERENCE_VERSION,
  SERVER_ACTION_REQUEST_MARKER,
  SERVER_ACTION_REQUEST_VERSION,
  SERVER_ACTION_RESPONSE_MARKER,
  SERVER_ACTION_RESPONSE_VERSION,
  SERVER_PAYLOAD_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_VERSION,
  SERVER_PAYLOAD_VERSION,
  createClientReferencePayload,
  createServerActionErrorResponse,
  createServerActionOkResponse,
  createServerActionPayloadResponse,
  createServerActionRedirectResponse,
  createServerActionReferencePayload,
  createServerActionRequest,
  parseClientReferenceId,
  validateClientReferencePayload,
  validateServerActionReferencePayload,
  validateServerActionRequest,
  validateServerActionResponse,
  validateServerPayloadPacket,
  validateServerPayloadStreamFrame,
} from "../dist/index.js";

test("creates and validates client reference payloads", () => {
  const payload = createClientReferencePayload({
    id: "app/posts/[id]/PostActions.tsx#default",
    props: { id: "alpha", enabled: true, count: 3 },
  });

  assert.deepEqual(payload, {
    ferrite: CLIENT_REFERENCE_MARKER,
    version: CLIENT_REFERENCE_VERSION,
    id: "app/posts/[id]/PostActions.tsx#default",
    module: "app/posts/[id]/PostActions.tsx",
    exportName: "default",
    props: { id: "alpha", enabled: true, count: 3 },
  });
  assert.deepEqual(parseClientReferenceId(payload.id), {
    module: "app/posts/[id]/PostActions.tsx",
    exportName: "default",
  });
  assert.equal(validateClientReferencePayload(payload), payload);
});

test("rejects malformed client reference modules", () => {
  assert.throws(
    () => createClientReferencePayload({ id: "../PostActions.tsx#default" }),
    /invalid client reference module/,
  );
  assert.throws(
    () => validateClientReferencePayload({
      ferrite: CLIENT_REFERENCE_MARKER,
      version: CLIENT_REFERENCE_VERSION,
      id: "app/Button.tsx#default",
      module: "app/Button.tsx",
      exportName: "default",
      props: { bad: Number.POSITIVE_INFINITY },
    }),
    /must be JSON-serializable/,
  );
});

test("validates server payload packets and stream frames", () => {
  const reference = createClientReferencePayload({
    id: "app/Button.tsx#default",
    props: { label: "Save" },
  });
  const chunk = {
    id: "s0",
    root: [0, "chunk"],
    clientReferences: [reference],
  };
  const packet = {
    ferrite: SERVER_PAYLOAD_MARKER,
    version: SERVER_PAYLOAD_VERSION,
    shell: [0, "shell"],
    clientReferences: [reference],
    chunks: [chunk],
  };

  assert.equal(validateServerPayloadPacket(packet), packet);
  assert.deepEqual(validateServerPayloadStreamFrame({
    ferrite: SERVER_PAYLOAD_STREAM_FRAME_MARKER,
    version: SERVER_PAYLOAD_STREAM_FRAME_VERSION,
    kind: "shell",
    shell: [0, "shell"],
    clientReferences: [reference],
  }).kind, "shell");
  assert.deepEqual(validateServerPayloadStreamFrame({
    ferrite: SERVER_PAYLOAD_STREAM_FRAME_MARKER,
    version: SERVER_PAYLOAD_STREAM_FRAME_VERSION,
    kind: "chunk",
    chunk,
  }).kind, "chunk");
});

test("rejects malformed server payload chunks", () => {
  assert.throws(
    () => validateServerPayloadPacket({
      ferrite: SERVER_PAYLOAD_MARKER,
      version: SERVER_PAYLOAD_VERSION,
      shell: [0, "shell"],
      clientReferences: [],
      chunks: [{ id: "bad id", root: [0, "chunk"], clientReferences: [] }],
    }),
    /invalid stream chunk id/,
  );
  assert.throws(
    () => validateServerPayloadStreamFrame({
      ferrite: SERVER_PAYLOAD_STREAM_FRAME_MARKER,
      version: SERVER_PAYLOAD_STREAM_FRAME_VERSION,
      kind: "chunk",
      chunk: { id: "", root: [0, "chunk"], clientReferences: [] },
    }),
    /requires a non-empty id/,
  );
});

test("creates and validates server action protocol values", () => {
  const reference = createServerActionReferencePayload({
    id: "app/posts/[id]/page.tsx#createPost",
    routePattern: "/posts/[id]",
    bound: { postId: "abc" },
  });
  assert.deepEqual(reference, {
    ferrite: SERVER_ACTION_REFERENCE_MARKER,
    version: SERVER_ACTION_REFERENCE_VERSION,
    id: "app/posts/[id]/page.tsx#createPost",
    routePattern: "/posts/[id]",
    url: "/_ferrite/action",
    bound: { postId: "abc" },
  });
  assert.equal(validateServerActionReferencePayload(reference), reference);

  const request = createServerActionRequest({
    id: reference.id,
    routePath: "/posts/abc",
    form: {
      title: "Hello",
      tag: ["rust", "tsx"],
    },
  });
  assert.deepEqual(request, {
    ferrite: SERVER_ACTION_REQUEST_MARKER,
    version: SERVER_ACTION_REQUEST_VERSION,
    id: reference.id,
    routePath: "/posts/abc",
    form: {
      title: "Hello",
      tag: ["rust", "tsx"],
    },
  });
  assert.equal(validateServerActionRequest(request), request);

  assert.deepEqual(createServerActionOkResponse({ data: { saved: true } }), {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "ok",
    data: { saved: true },
  });
  assert.deepEqual(createServerActionRedirectResponse({ location: "/posts/abc?draft=1#saved" }), {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "redirect",
    location: "/posts/abc?draft=1#saved",
  });
  assert.deepEqual(createServerActionErrorResponse({ code: "POST_CONFLICT", message: "Could not save post." }), {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    code: "POST_CONFLICT",
    message: "Could not save post.",
  });
  assert.deepEqual(createServerActionErrorResponse({ message: "Legacy public error." }), {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    message: "Legacy public error.",
  });
  assert.deepEqual(validateServerActionResponse({
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    message: "Legacy public error.",
  }), {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    message: "Legacy public error.",
  });

  const payloadResponse = createServerActionPayloadResponse({
    payload: {
      ferrite: SERVER_PAYLOAD_MARKER,
      version: SERVER_PAYLOAD_VERSION,
      shell: [0, "updated"],
      clientReferences: [],
      chunks: [],
    },
  });
  assert.equal(validateServerActionResponse(payloadResponse), payloadResponse);
});

test("rejects malformed server action protocol values", () => {
  assert.throws(
    () => createServerActionErrorResponse({ code: "post-conflict", message: "Could not save post." }),
    /server action error code/,
  );
  assert.throws(
    () =>
      validateServerActionReferencePayload({
        ferrite: SERVER_ACTION_REFERENCE_MARKER,
        version: SERVER_ACTION_REFERENCE_VERSION,
        id: "",
        routePattern: "/posts/[id]",
        url: "/_ferrite/action",
        bound: {},
      }),
    /server action id must be non-empty/,
  );

  assert.throws(
    () =>
      validateServerActionRequest({
        ferrite: SERVER_ACTION_REQUEST_MARKER,
        version: SERVER_ACTION_REQUEST_VERSION,
        id: "app/posts/[id]/page.tsx#createPost",
        routePath: "posts/abc",
        form: {},
      }),
    /route path must start/,
  );

  assert.throws(
    () =>
      validateServerActionRequest({
        ferrite: SERVER_ACTION_REQUEST_MARKER,
        version: SERVER_ACTION_REQUEST_VERSION,
        id: "app/posts/[id]/page.tsx#createPost",
        routePath: "/posts/abc",
        form: { title: ["ok", 1] },
      }),
    /must be a string or string array/,
  );

  assert.throws(
    () =>
      validateServerActionResponse({
        ferrite: SERVER_ACTION_RESPONSE_MARKER,
        version: SERVER_ACTION_RESPONSE_VERSION,
        status: "ok",
        data: { saved: true },
        location: "/posts/abc",
      }),
    /unsupported field "location"/,
  );
});
