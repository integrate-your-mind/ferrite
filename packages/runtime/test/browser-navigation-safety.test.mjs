import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";

import { createElement } from "../dist/index.js";
import {
  createServerPayloadNavigator,
  fetchAndApplyServerPayloadStream,
  fetchServerPayload,
  mount,
} from "../dist/dom.js";

function documentPayload(route, text) {
  return {
    ferrite: "server-payload",
    version: 1,
    shell: [
      2,
      "html",
      {},
      [
        [2, "head", {}, [[2, "title", {}, [[0, text]]]]],
        [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": route }, [[2, "h1", {}, [[0, text]]]]]]],
      ],
    ],
    clientReferences: [],
    chunks: [],
  };
}

function jsonResponse(packet) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    json: async () => packet,
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

test("a slower older navigation cannot replace a newer route", async () => {
  const window = new Window({ url: "https://example.test/" });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = mount(createElement("div", { id: "ferrite-root" }, createElement("h1", null, "Initial")), container);
  const pending = new Map();
  const fetch = (input) => new Promise((resolve) => {
    const url = new URL(String(input));
    pending.set(url.pathname, resolve);
  });
  const navigator = createServerPayloadNavigator(root, { window, fetch });

  const slow = navigator.navigate("/slow");
  await waitFor(() => pending.has("/slow"));
  const fast = navigator.navigate("/fast");
  await waitFor(() => pending.has("/fast"));
  pending.get("/fast")(jsonResponse(documentPayload("/fast", "Fast")));
  await fast;
  assert.equal(container.querySelector("h1")?.textContent, "Fast");
  assert.equal(window.location.pathname, "/fast");

  pending.get("/slow")(jsonResponse(documentPayload("/slow", "Slow")));
  assert.equal(await slow, null);
  assert.equal(container.querySelector("h1")?.textContent, "Fast");
  assert.equal(window.location.pathname, "/fast");
  navigator.destroy();
});

test("stream responses enforce per-frame and total frame budgets before DOM commits", async () => {
  let updates = 0;
  const root = { update() { updates += 1; }, unmount() {} };
  const oversized = `${"x".repeat(80)}\n`;
  const fetchOversized = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); controller.close(); } }),
  });
  await assert.rejects(
    fetchAndApplyServerPayloadStream(root, "/stream", {
      fetch: fetchOversized,
      maxFrameBytes: 64,
      maxResponseBytes: 1024,
    }),
    /maxFrameBytes/,
  );
  assert.equal(updates, 0);

  const frames = [
    {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "shell",
      shell: [2, "div", {}, []],
      clientReferences: [],
    },
    {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "chunk",
      chunk: { id: "one", root: [0, "one"], clientReferences: [] },
    },
    {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "chunk",
      chunk: { id: "two", root: [0, "two"], clientReferences: [] },
    },
  ];
  const encoded = new TextEncoder().encode(`${frames.map(JSON.stringify).join("\n")}\n`);
  const fetchFrames = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }),
  });
  await assert.rejects(
    fetchAndApplyServerPayloadStream(root, "/stream", { fetch: fetchFrames, maxFrames: 2 }),
    /maxFrames/,
  );
});

test("packet trees enforce depth budgets", async () => {
  let node = [0, "leaf"];
  for (let depth = 0; depth < 8; depth += 1) {
    node = [2, "div", {}, [node]];
  }
  await assert.rejects(
    fetchServerPayload("/deep", {
      fetch: async () => jsonResponse({
        ferrite: "server-payload",
        version: 1,
        shell: node,
        clientReferences: [],
        chunks: [],
      }),
      maxTreeDepth: 4,
    }),
    /maxTreeDepth/,
  );
});

test("prefetch state uses a bounded LRU cache", async () => {
  const window = new Window({ url: "https://example.test/" });
  const root = { update() {}, unmount() {} };
  let requests = 0;
  const fetch = async (input) => {
    requests += 1;
    const path = new URL(String(input)).pathname;
    return jsonResponse(documentPayload(path, path));
  };
  const navigator = createServerPayloadNavigator(root, {
    window,
    fetch,
    maxPrefetchEntries: 2,
    prefetchTtlMs: 60_000,
  });

  await navigator.prefetch("/a");
  await navigator.prefetch("/b");
  await navigator.prefetch("/c");
  await navigator.prefetch("/a");
  assert.equal(requests, 4);
  navigator.destroy();
});

test("destroy aborts an active navigation", async () => {
  const window = new Window({ url: "https://example.test/" });
  const root = { update() {}, unmount() {} };
  let signal;
  let resolveRequest;
  const fetch = (_input, init) => new Promise((resolve) => {
    signal = init?.signal;
    resolveRequest = resolve;
  });
  const navigator = createServerPayloadNavigator(root, { window, fetch });
  const navigation = navigator.navigate("/slow");
  await waitFor(() => Boolean(signal));
  navigator.destroy();
  assert.equal(signal.aborted, true);
  resolveRequest(jsonResponse(documentPayload("/slow", "Slow")));
  assert.equal(await navigation, null);
});
