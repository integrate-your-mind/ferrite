import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareSsrHandler } from "../dist/cloudflare.js";

const BUILD_ID = `sha256:${"a".repeat(64)}`;

function routeModule(render, {
  path = "/docs",
  fallbackPath = "/docs/index.html",
  sourceBuildId = BUILD_ID,
  assetBuildId = BUILD_ID,
  observedActions = [],
} = {}) {
  return {
    pageModule: { default() {} },
    layoutModules: [],
    documentModule: null,
    conventionModules: {},
    routePattern: path,
    cloudflare: {
      format: "ferrite-cloudflare-route",
      version: 1,
      sourceBuildId,
      assetBuildId,
      path,
      fallbackPath,
      observedActions,
    },
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
    renderPacketJsonToHtml(json, maxOutputBytes) {
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
}), buildId = BUILD_ID) {
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/ferrite-server.json") {
          return new Response(JSON.stringify({
            format: { name: "ferrite-server", major: 1, minor: 0 },
            buildId,
            routes: [{
              path: "/docs",
              prerendered: { "/docs": "docs/index.html" },
              observedActions: [],
            }],
          }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        seen.push({ method: request.method, pathname });
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
      responseDeadlineMs: 5,
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
        module: routeModule(scenario.render),
      }],
      renderer: textRenderer(),
      responseDeadlineMs: scenario.responseDeadlineMs,
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
      module: routeModule(() => new Promise(() => {})),
    }],
    renderer: textRenderer(),
    responseDeadlineMs: 5,
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

  const invalidRendererSeen = [];
  const invalidRenderer = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, "dynamic"],
      })),
    }],
    renderer: {
      renderPacketJsonToHtml() {
        return { html: "not text" };
      },
    },
  });
  const invalidRendererResponse = await invalidRenderer.fetch(
    new Request("https://example.test/docs"),
    assets(invalidRendererSeen),
  );
  assert.equal(invalidRendererResponse.status, 200);
  assert.equal(invalidRendererResponse.headers.get("x-ferrite-render"), "static-fallback");
  assert.deepEqual(invalidRendererSeen, [{ method: "GET", pathname: "/docs/index.html" }]);
});

test("fails closed when route code and static assets do not share one build identity", async () => {
  let renders = 0;
  const handler = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => {
        renders += 1;
        return { ferrite: "render-packet", version: 1, root: [0, "dynamic"] };
      }),
    }],
    renderer: textRenderer(),
  });

  const environments = [
    assets([], undefined, `sha256:${"b".repeat(64)}`),
    {
      ASSETS: {
        async fetch() {
          return new Response("x".repeat((64 * 1024) + 1));
        },
      },
    },
    ...[
      {
        path: "/docs",
        prerendered: { "/docs": "private.html" },
        observedActions: [],
      },
      {
        path: "/docs",
        prerendered: { "/docs": "docs/index.html" },
        observedActions: ["save"],
      },
    ].map((route) => ({
      ASSETS: {
        async fetch() {
          return new Response(JSON.stringify({
            format: { name: "ferrite-server", major: 1, minor: 0 },
            buildId: BUILD_ID,
            routes: [route],
          }));
        },
      },
    })),
  ];
  for (const env of environments) {
    const response = await handler.fetch(
      new Request("https://example.test/docs"),
      env,
    );
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Internal server error");
  }
  assert.equal(renders, 0);
});

test("sanitizes full-document rollback requests and rejects partial fallback HTML", async () => {
  const fallbackRequests = [];
  const handler = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => {
        throw new Error("render failed");
      }),
    }],
    renderer: textRenderer(),
  });
  const env = {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/ferrite-server.json") {
          return new Response(JSON.stringify({
            format: { name: "ferrite-server", major: 1, minor: 0 },
            buildId: BUILD_ID,
            routes: [{
              path: "/docs",
              prerendered: { "/docs": "docs/index.html" },
              observedActions: [],
            }],
          }));
        }
        fallbackRequests.push({
          pathname,
          range: request.headers.get("range"),
          ifNoneMatch: request.headers.get("if-none-match"),
        });
        return new Response("partial", {
          status: 206,
          headers: { "Content-Range": "bytes 0-6/20" },
        });
      },
    },
  };
  const response = await handler.fetch(
    new Request("https://example.test/docs", {
      headers: {
        Range: "bytes=0-6",
        "If-None-Match": "\"stale\"",
      },
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Internal server error");
  assert.deepEqual(fallbackRequests, [{
    pathname: "/docs/index.html",
    range: null,
    ifNoneMatch: null,
  }]);
});

test("fails closed for malformed, unsupported, aborted, and unavailable fallback paths", async () => {
  let renders = 0;
  const seen = [];
  const handler = createCloudflareSsrHandler({
    routes: [{
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

  const componentAbort = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => {
        throw new DOMException("component failure", "AbortError");
      }),
    }],
    renderer: textRenderer(),
  });
  const componentAbortSeen = [];
  const componentAbortResponse = await componentAbort.fetch(
    new Request("https://example.test/docs"),
    assets(componentAbortSeen),
  );
  assert.equal(componentAbortResponse.status, 200);
  assert.equal(componentAbortResponse.headers.get("x-ferrite-render"), "static-fallback");
  assert.deepEqual(componentAbortSeen, [{ method: "GET", pathname: "/docs/index.html" }]);
});

test("rejects server-action controls found in the rendered packet", async () => {
  for (const root of [
    [2, "form", { action: "/_ferrite/action" }, [[0, "Save"]]],
    [2, "section", {}, [[2, "input", { name: "__ferrite_action", value: "save" }, []]]],
  ]) {
    const seen = [];
    const handler = createCloudflareSsrHandler({
      routes: [{
        module: routeModule(() => ({
          ferrite: "render-packet",
          version: 1,
          root,
        })),
      }],
      renderer: textRenderer(),
    });
    const response = await handler.fetch(
      new Request("https://example.test/docs"),
      assets(seen),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ferrite-render"), "static-fallback");
    assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }]);
  }
});

test("rejects routes outside the initial static, action-free Worker compatibility tier", () => {
  const base = {
    module: routeModule(() => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] })),
  };
  const renderer = textRenderer();

  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{
        module: routeModule(
          () => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] }),
          { path: "/posts/:slug" },
        ),
      }],
      renderer,
    }),
    /exact routes only/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{
        module: routeModule(
          () => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] }),
          { observedActions: ["save"] },
        ),
      }],
      renderer,
    }),
    /server actions/,
  );
  const withoutIdentity = structuredClone(base);
  delete withoutIdentity.module.cloudflare;
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [withoutIdentity],
      renderer,
    }),
    /generated edge identity/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{
        module: {
          ...base.module,
          routePattern: "/other",
        },
      }],
      renderer,
    }),
    /does not match module pattern/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{
        module: routeModule(
          () => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] }),
          { fallbackPath: "/docs/%2e%2e/private" },
        ),
      }],
      renderer,
    }),
    /cannot contain percent-encoded/,
  );
});
