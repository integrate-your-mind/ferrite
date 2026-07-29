import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareSsrHandler } from "../dist/cloudflare.js";

function routeModule(render) {
  return {
    pageModule: { default() {} },
    layoutModules: [],
    documentModule: null,
    conventionModules: {},
    routePattern: "/docs",
    serverRuntime: {
      async collectPageMetadata() {
        return {};
      },
      async renderPageModuleToPacket() {
        return render();
      },
      async renderDocumentModuleToPacket() {
        throw new Error("document rendering was not expected");
      },
    },
  };
}

function textRenderer() {
  return {
    renderJsonToHtml(json, maxOutputBytes) {
      const packet = JSON.parse(json);
      const text = packet.root[1];
      if (new TextEncoder().encode(text).byteLength > maxOutputBytes) {
        throw new TypeError("render output exceeded limit");
      }
      return text;
    },
  };
}

function assets(seen, response = new Response("static docs", {
  status: 200,
  headers: { "Content-Type": "text/html; charset=utf-8" },
})) {
  return {
    ASSETS: {
      async fetch(request) {
        seen.push({ method: request.method, pathname: new URL(request.url).pathname });
        return response.clone();
      },
    },
  };
}

test("renders exact deep routes at request time and leaves assets on the binding", async () => {
  let renders = 0;
  const seen = [];
  const handler = createCloudflareSsrHandler({
    routes: [{
      path: "/docs",
      fallbackPath: "/docs/index.html",
      observedActions: [],
      module: routeModule(() => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, `request render ${++renders}`],
      })),
    }],
    renderer: textRenderer(),
  });
  const env = assets(seen);

  const first = await handler.fetch(new Request("https://example.test/docs?campaign=one"), env);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "request render 1");
  assert.equal(first.headers.get("x-ferrite-render"), "request");
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");

  const second = await handler.fetch(new Request("https://example.test/docs"), env);
  assert.equal(await second.text(), "request render 2");
  const head = await handler.fetch(new Request("https://example.test/docs", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(renders, 3);

  const asset = await handler.fetch(new Request("https://example.test/app.js"), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "static docs");
  assert.deepEqual(seen, [{ method: "GET", pathname: "/app.js" }]);

  const noContent = await handler.fetch(
    new Request("https://example.test/empty"),
    assets([], new Response(null, { status: 204 })),
  );
  assert.equal(noContent.status, 204);
  assert.equal(await noContent.text(), "");
});

test("falls back only to the declared static route on render failure, deadline, or rollback", async () => {
  const scenarios = [
    {
      name: "render failure",
      render: () => {
        throw new Error("private failure");
      },
    },
    {
      name: "deadline",
      render: () => new Promise(() => {}),
      maxRenderMs: 5,
    },
    {
      name: "packet limit",
      render: () => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, "x".repeat(256)],
      }),
      maxPacketBytes: 32,
    },
    {
      name: "HTML limit",
      render: () => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, "larger than four bytes"],
      }),
      maxHtmlBytes: 4,
    },
  ];

  for (const scenario of scenarios) {
    const seen = [];
    const handler = createCloudflareSsrHandler({
      routes: [{
        path: "/docs",
        fallbackPath: "/docs/index.html",
        observedActions: [],
        module: routeModule(scenario.render),
      }],
      renderer: textRenderer(),
      maxRenderMs: scenario.maxRenderMs,
      maxPacketBytes: scenario.maxPacketBytes,
      maxHtmlBytes: scenario.maxHtmlBytes,
    });
    const response = await handler.fetch(
      new Request("https://example.test/docs?private=1"),
      assets(seen),
    );
    assert.equal(response.status, 200, scenario.name);
    assert.equal(await response.text(), "static docs", scenario.name);
    assert.equal(response.headers.get("x-ferrite-render"), "static-fallback", scenario.name);
    assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }], scenario.name);
  }

  const deadlineWithoutFallback = createCloudflareSsrHandler({
    routes: [{
      path: "/docs",
      fallbackPath: "/docs/index.html",
      observedActions: [],
      module: routeModule(() => new Promise(() => {})),
    }],
    renderer: textRenderer(),
    maxRenderMs: 5,
  });
  const timedOut = await deadlineWithoutFallback.fetch(
    new Request("https://example.test/docs"),
    {},
  );
  assert.equal(timedOut.status, 504);
  assert.equal(await timedOut.text(), "Gateway timeout");

  let renders = 0;
  const seen = [];
  const rollback = createCloudflareSsrHandler({
    routes: [{
      path: "/docs",
      fallbackPath: "/docs/index.html",
      observedActions: [],
      module: routeModule(() => {
        renders += 1;
        return { ferrite: "render-packet", version: 1, root: [0, "dynamic"] };
      }),
    }],
    renderer: textRenderer(),
    shouldRender: () => false,
  });
  assert.equal(
    await (await rollback.fetch(new Request("https://example.test/docs"), assets(seen))).text(),
    "static docs",
  );
  assert.equal(renders, 0);
  assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }]);
});

test("fails closed for malformed, unsupported, aborted, and unavailable fallback paths", async () => {
  let renders = 0;
  const seen = [];
  const handler = createCloudflareSsrHandler({
    routes: [{
      path: "/docs",
      fallbackPath: "/docs/index.html",
      observedActions: [],
      module: routeModule(() => {
        renders += 1;
        throw new Error("render failed");
      }),
    }],
    renderer: textRenderer(),
  });
  const env = assets(seen, new Response("missing", { status: 404 }));

  for (const [url, status] of [
    ["https://example.test/%E0%A4%A", 400],
    ["https://example.test/%252e%252e/private", 400],
    ["https://example.test/docs%5cprivate", 400],
    ["https://example.test/docs%00private", 400],
  ]) {
    assert.equal((await handler.fetch(new Request(url), env)).status, status);
  }
  assert.equal(
    (await handler.fetch(new Request("https://example.test/docs", { method: "POST" }), env)).status,
    405,
  );
  assert.equal(
    (await handler.fetch(new Request("https://example.test/docs", {
      headers: { Accept: "application/json" },
    }), env)).status,
    406,
  );
  assert.equal(
    (await handler.fetch(new Request("https://example.test/docs", {
      headers: { Accept: "text/html;q=0, application/json" },
    }), env)).status,
    406,
  );
  assert.equal(
    (await handler.fetch(new Request("https://example.test/docs?__ferrite_payload=stream"), env)).status,
    501,
  );
  assert.equal(renders, 0);
  assert.equal(seen.length, 0);

  const failed = await handler.fetch(new Request("https://example.test/docs"), env);
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), "Internal server error");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    handler.fetch(new Request("https://example.test/docs", { signal: controller.signal }), assets([])),
    (error) => error?.name === "AbortError",
  );

  const duringController = new AbortController();
  const duringSeen = [];
  const pendingHandler = createCloudflareSsrHandler({
    routes: [{
      path: "/docs",
      fallbackPath: "/docs/index.html",
      observedActions: [],
      module: routeModule(() => new Promise(() => {})),
    }],
    renderer: textRenderer(),
  });
  const pending = pendingHandler.fetch(
    new Request("https://example.test/docs", { signal: duringController.signal }),
    assets(duringSeen),
  );
  duringController.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(duringSeen, []);
});

test("rejects routes outside the initial static, action-free Worker compatibility tier", () => {
  const base = {
    fallbackPath: "/docs/index.html",
    observedActions: [],
    module: routeModule(() => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] })),
  };
  const renderer = textRenderer();

  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{ ...base, path: "/posts/:slug" }],
      renderer,
    }),
    /exact routes only/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{ ...base, path: "/docs", observedActions: ["save"] }],
      renderer,
    }),
    /server actions/,
  );
  const { observedActions: _actions, ...withoutActionInventory } = base;
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{ ...withoutActionInventory, path: "/docs" }],
      renderer,
    }),
    /build-observed server action list/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{ ...base, path: "/other" }],
      renderer,
    }),
    /does not match module pattern/,
  );
});
