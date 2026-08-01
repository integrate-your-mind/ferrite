import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { instantiateFerriteProtocolWasm } from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(packageRoot, "dist", "ferrite_protocol_wasm.wasm");

async function loadProtocolWasm() {
  return instantiateFerriteProtocolWasm(await readFile(wasmPath));
}

test("validates server payload JSON through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.doesNotThrow(() =>
    protocol.validateServerPayloadJson(JSON.stringify({
      ferrite: "server-payload",
      version: 1,
      shell: [0, "shell"],
      clientReferences: [],
      chunks: [],
    })),
  );
});

test("returns typed payloads after WASM validation", async () => {
  const protocol = await loadProtocolWasm();
  const payload = {
    ferrite: "server-payload",
    version: 1,
    shell: [0, "shell"],
    clientReferences: [],
    chunks: [],
  };

  assert.equal(protocol.validateServerPayload(payload), payload);
});

test("validates server payload stream frames through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();
  const shell = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "shell",
    shell: [0, "shell"],
    clientReferences: [],
  };
  const chunk = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "chunk",
    chunk: { id: "s0", root: [0, "chunk"], clientReferences: [] },
  };

  assert.doesNotThrow(() =>
    protocol.validateServerPayloadStreamFrameJson(JSON.stringify(shell)),
  );
  assert.equal(protocol.validateServerPayloadStreamFrame(chunk), chunk);
});

test("rejects invalid server payloads through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.throws(
    () =>
      protocol.validateServerPayloadJson(JSON.stringify({
        ferrite: "server-payload",
        version: 1,
        shell: [0, "shell"],
        clientReferences: [],
        chunks: [{ id: "bad id", root: [0, "chunk"], clientReferences: [] }],
      })),
    /invalid stream chunk id/,
  );
});

test("rejects invalid stream frames through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.throws(
    () =>
      protocol.validateServerPayloadStreamFrameJson(JSON.stringify({
        ferrite: "server-payload-frame",
        version: 1,
        kind: "chunk",
        chunk: { id: "bad id", root: [0, "chunk"], clientReferences: [] },
      })),
    /invalid stream chunk id/,
  );
});

test("rejects malformed server payload JSON through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.throws(
    () => protocol.validateServerPayloadJson("{"),
    /invalid server payload JSON/,
  );
});

test("renders canonical escaped HTML through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();
  const packet = {
    ferrite: "render-packet",
    version: 1,
    root: [2, "main", { "data-label": "\"<&" }, [[0, "<Ferrite & Workers>"]]],
  };

  assert.equal(
    protocol.renderPacketJsonToHtml(JSON.stringify(packet)),
    "<main data-label=\"&quot;&lt;&amp;\">&lt;Ferrite &amp; Workers&gt;</main>",
  );
});

test("rejects malformed and oversized render output through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.throws(() => protocol.renderPacketJsonToHtml("{"), /invalid/i);
  assert.throws(
    () =>
      protocol.renderPacketJsonToHtml(
        JSON.stringify({
          ferrite: "render-packet",
          version: 1,
          root: [0, "larger than four bytes"],
        }),
        4,
      ),
    /exceeds the 4-byte output limit/,
  );
  assert.throws(
    () => protocol.renderPacketJsonToHtml("{}", 0),
    /positive 32-bit integer/,
  );
});
