import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_REFERENCE_MARKER,
  CLIENT_REFERENCE_VERSION,
  SERVER_PAYLOAD_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_VERSION,
  SERVER_PAYLOAD_VERSION,
  createClientReferencePayload,
  parseClientReferenceId,
  validateClientReferencePayload,
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
