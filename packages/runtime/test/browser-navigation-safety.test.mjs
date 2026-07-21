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

test("stream responses reject an oversized first frame without a DOM commit", async () => {
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
});

test("frame budgets are independent of transport chunking and preserve validated shell progress", async () => {
  const frames = [
    {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "shell",
      shell: [2, "div", { "data-ferrite-suspense-boundary": "one" }, [[0, "Loading"]]],
      clientReferences: [],
    },
    {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "chunk",
      chunk: { id: "one", root: [0, "one"], clientReferences: [] },
    },
  ];
  const encoder = new TextEncoder();
  const encodedFrames = frames.map((frame) => encoder.encode(`${JSON.stringify(frame)}\n`));

  async function observedUpdates(transportChunks) {
    let updates = 0;
    const root = { update() { updates += 1; }, unmount() {} };
    const fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: delayedReadableStream(transportChunks),
    });
    await assert.rejects(
      fetchAndApplyServerPayloadStream(root, "/stream", { fetch, maxFrames: 1 }),
      /maxFrames/,
    );
    return updates;
  }

  const coalesced = new Uint8Array(encodedFrames[0].byteLength + encodedFrames[1].byteLength);
  coalesced.set(encodedFrames[0], 0);
  coalesced.set(encodedFrames[1], encodedFrames[0].byteLength);
  assert.equal(await observedUpdates([coalesced]), 1);
  assert.equal(await observedUpdates(encodedFrames), 1);
});

test("stream navigation commits target history with its validated shell", async () => {
  const window = new Window({ url: "https://example.test/old" });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = mount(createElement("div", { id: "ferrite-root" }, createElement("h1", null, "Old")), container);
  const encoder = new TextEncoder();
  let streamController;
  let historyCommits = 0;
  const pushState = window.history.pushState.bind(window.history);
  window.history.pushState = (...args) => {
    historyCommits += 1;
    return pushState(...args);
  };
  const errors = [];
  const navigator = createServerPayloadNavigator(root, {
    window,
    stream: true,
    maxFrames: 1,
    onError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: new ReadableStream({ start(controller) { streamController = controller; } }),
    }),
  });

  const navigation = navigator.navigate("/new");
  await waitFor(() => Boolean(streamController));
  streamController.enqueue(encoder.encode(`${JSON.stringify({
    ferrite: "server-payload-frame",
    version: 1,
    kind: "shell",
    shell: documentPayload("/new", "New").shell,
    clientReferences: [],
  })}\n`));
  await waitFor(() => container.querySelector("h1")?.textContent === "New");
  assert.equal(window.location.pathname, "/new");
  assert.equal(historyCommits, 1);

  streamController.enqueue(encoder.encode(`${JSON.stringify({
    ferrite: "server-payload-frame",
    version: 1,
    kind: "chunk",
    chunk: { id: "late", root: [0, "Rejected"], clientReferences: [] },
  })}\n`));
  streamController.close();
  await assert.rejects(navigation, /maxFrames/);
  assert.equal(window.location.pathname, "/new");
  assert.equal(container.querySelector("h1")?.textContent, "New");
  assert.deepEqual(errors, ["Ferrite server payload stream exceeds maxFrames."]);
  navigator.destroy();
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

test("packet trees enforce shell-only node budgets", async () => {
  await assert.rejects(
    fetchServerPayload("/wide", {
      fetch: async () => jsonResponse(documentPayload("/wide", "Wide")),
      maxTreeNodes: 2,
    }),
    /maxTreeNodes/,
  );
});

test("body-less packet responses still enforce serialized byte budgets", async () => {
  await assert.rejects(
    fetchServerPayload("/large", {
      fetch: async () => jsonResponse(documentPayload("/large", "x".repeat(256))),
      maxResponseBytes: 64,
    }),
    /maxResponseBytes/,
  );
});

test("declared oversized responses cancel their unread body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchServerPayload("/declared-large", {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-length": "1024" }),
        body,
        json: async () => documentPayload("/declared-large", "Large"),
      }),
      maxResponseBytes: 64,
    }),
    /maxResponseBytes/,
  );
  assert.equal(cancelled, true);
});

test("packet readers cancel and release their lock after a cumulative byte overflow", async () => {
  let cancelled = false;
  const body = delayedReadableStream([
    new Uint8Array(40).fill(32),
    new Uint8Array(40).fill(32),
    new Uint8Array(40).fill(32),
  ], () => {
    cancelled = true;
  });
  await assert.rejects(
    fetchServerPayload("/cumulative-large", {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body,
      }),
      maxResponseBytes: 64,
    }),
    /maxResponseBytes/,
  );
  assert.equal(cancelled, true);
  const reader = body.getReader();
  reader.releaseLock();
});

test("packet byte budgets accept the exact serialized boundary", async () => {
  const packet = documentPayload("/exact", "Exact");
  const encoded = new TextEncoder().encode(JSON.stringify(packet));
  const result = await fetchServerPayload("/exact", {
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(encoded.byteLength) }),
      body: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }),
      json: async () => packet,
    }),
    maxResponseBytes: encoded.byteLength,
  });
  assert.deepEqual(result, packet);
});

test("stream tree budgets reject a later frame without applying it", async () => {
  const encoder = new TextEncoder();
  const shell = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "shell",
    shell: [2, "div", { "data-ferrite-suspense-boundary": "one" }, [[0, "Loading"]]],
    clientReferences: [],
  };
  const chunk = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "chunk",
    chunk: { id: "one", root: [0, "Loaded"], clientReferences: [] },
  };
  let updates = 0;
  await assert.rejects(
    fetchAndApplyServerPayloadStream(
      { update() { updates += 1; }, unmount() {} },
      "/tree-limit",
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body: delayedReadableStream([
            encoder.encode(`${JSON.stringify(shell)}\n`),
            encoder.encode(`${JSON.stringify(chunk)}\n`),
          ]),
        }),
        maxTreeNodes: 2,
      },
    ),
    /maxTreeNodes/,
  );
  assert.equal(updates, 1);
});

test("stream framing preserves CRLF, split UTF-8, and an unterminated final frame", async () => {
  const encoder = new TextEncoder();
  const shell = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "shell",
    shell: [2, "div", { "data-ferrite-suspense-boundary": "one" }, [[0, "Loading café"]]],
    clientReferences: [],
  };
  const chunk = {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "chunk",
    chunk: { id: "one", root: [0, "Loaded café"], clientReferences: [] },
  };
  const encoded = encoder.encode(`${JSON.stringify(shell)}\r\n${JSON.stringify(chunk)}`);
  const utf8Split = encoded.findIndex((byte, index) => byte === 0xc3 && encoded[index + 1] === 0xa9) + 1;
  assert.ok(utf8Split > 0, "fixture must split a multi-byte UTF-8 sequence");
  let updates = 0;
  const packet = await fetchAndApplyServerPayloadStream(
    { update() { updates += 1; }, unmount() {} },
    "/split-utf8",
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: delayedReadableStream([
          encoded.slice(0, utf8Split),
          encoded.slice(utf8Split, utf8Split + 1),
          encoded.slice(utf8Split + 1),
        ]),
      }),
      maxResponseBytes: encoded.byteLength,
      maxFrames: 2,
    },
  );
  assert.equal(updates, 2);
  assert.equal(packet.chunks.length, 1);
  assert.match(JSON.stringify(packet), /café/);
});

test("stream frame overflow cancels and unlocks the source reader", async () => {
  let cancelled = false;
  const body = delayedReadableStream([
    new TextEncoder().encode("x".repeat(40)),
    new TextEncoder().encode("still pending"),
  ], () => {
    cancelled = true;
  });
  await assert.rejects(
    fetchAndApplyServerPayloadStream(
      { update() {}, unmount() {} },
      "/oversized-frame",
      {
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          body,
        }),
        maxFrameBytes: 32,
      },
    ),
    /maxFrameBytes/,
  );
  assert.equal(cancelled, true);
  const reader = body.getReader();
  reader.releaseLock();
});

test("safety budgets reject non-positive and non-integer values before fetching", async () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let fetched = false;
    await assert.rejects(
      fetchServerPayload("/invalid-budget", {
        fetch: async () => {
          fetched = true;
          return jsonResponse(documentPayload("/invalid-budget", "Invalid"));
        },
        maxFrames: value,
      }),
      /positive safe integer/,
    );
    assert.equal(fetched, false);
  }
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

test("pending prefetch eviction aborts the least-recently-used request", async () => {
  const window = new Window({ url: "https://example.test/" });
  const requests = new Map();
  const fetch = (input, init) => new Promise((resolve) => {
    requests.set(new URL(String(input)).pathname, { resolve, signal: init?.signal });
  });
  const navigator = createServerPayloadNavigator({ update() {}, unmount() {} }, {
    window,
    fetch,
    maxPrefetchEntries: 2,
  });

  const first = navigator.prefetch("/a");
  const second = navigator.prefetch("/b");
  await waitFor(() => requests.size === 2);
  const firstAgain = navigator.prefetch("/a");
  const third = navigator.prefetch("/c");
  await waitFor(() => requests.size === 3);
  assert.equal(requests.get("/a").signal.aborted, false);
  assert.equal(requests.get("/b").signal.aborted, true);
  assert.equal(requests.get("/c").signal.aborted, false);

  for (const [path, request] of requests) {
    request.resolve(jsonResponse(documentPayload(path, path)));
  }
  await Promise.all([first, second, firstAgain, third]);
  navigator.destroy();
});

test("expired and destroyed prefetches abort their pending requests", async () => {
  const window = new Window({ url: "https://example.test/" });
  const requests = new Map();
  const fetch = (input, init) => new Promise((resolve) => {
    requests.set(new URL(String(input)).pathname, { resolve, signal: init?.signal });
  });
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const navigator = createServerPayloadNavigator({ update() {}, unmount() {} }, {
      window,
      fetch,
      prefetchTtlMs: 10,
    });
    const expired = navigator.prefetch("/expired");
    await waitFor(() => requests.has("/expired"));
    now += 11;
    const active = navigator.prefetch("/active");
    await waitFor(() => requests.has("/active"));
    assert.equal(requests.get("/expired").signal.aborted, true);
    assert.equal(requests.get("/active").signal.aborted, false);

    navigator.destroy();
    navigator.destroy();
    assert.equal(requests.get("/active").signal.aborted, true);
    await assert.rejects(navigator.prefetch("/after-destroy"), /destroyed/);
    await assert.rejects(navigator.navigate("/after-destroy"), /destroyed/);

    requests.get("/expired").resolve(jsonResponse(documentPayload("/expired", "Expired")));
    requests.get("/active").resolve(jsonResponse(documentPayload("/active", "Active")));
    await Promise.all([expired, active]);
  } finally {
    Date.now = originalNow;
  }
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

function delayedReadableStream(chunks, onCancel = () => undefined) {
  let cancelled = false;
  return new ReadableStream({
    start(controller) {
      const enqueue = (index) => {
        if (cancelled) {
          return;
        }
        controller.enqueue(chunks[index]);
        if (index + 1 === chunks.length) {
          controller.close();
          return;
        }
        setTimeout(() => enqueue(index + 1), 5);
      };
      enqueue(0);
    },
    cancel(reason) {
      cancelled = true;
      onCancel(reason);
    },
  });
}
