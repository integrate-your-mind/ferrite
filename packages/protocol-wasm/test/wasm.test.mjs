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

test("rejects malformed server payload JSON through Rust WASM", async () => {
  const protocol = await loadProtocolWasm();

  assert.throws(
    () => protocol.validateServerPayloadJson("{"),
    /invalid server payload JSON/,
  );
});
