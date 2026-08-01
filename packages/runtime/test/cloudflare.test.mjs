import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createCloudflareSsrHandler as createCloudflareSsrHandlerBase } from "../dist/cloudflare.js";

const BUILD_ID = `sha256:${"a".repeat(64)}`;
const METADATA_BUILD_ID = `sha256:${"e".repeat(64)}`;
const MODULE_BUILD_ID = `sha256:${"b".repeat(64)}`;
const MODULE_SHA256 = "c".repeat(64);
const RECEIPT_SHA256 = "d".repeat(64);
const DEFAULT_FALLBACK_BODY = "static docs";

function fileRecord(path, body) {
  const bytes = Buffer.from(body);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function routeModule(render, {
  path = "/docs",
  fallbackPath = "/docs/index.html",
  sourceBuildId = BUILD_ID,
  metadataBuildId = METADATA_BUILD_ID,
  moduleBuildId = MODULE_BUILD_ID,
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
      version: 2,
      sourceBuildId,
      metadataBuildId,
      moduleBuildId,
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

function manifestBytes({
  buildId = BUILD_ID,
  files = [fileRecord("docs/index.html", DEFAULT_FALLBACK_BODY)],
  routes = [{
    path: "/docs",
    prerendered: { "/docs": "docs/index.html" },
    observedActions: [],
    cloudflare: {
      path: "/docs",
      sourceBuildId: BUILD_ID,
      metadataBuildId: METADATA_BUILD_ID,
      moduleBuildId: MODULE_BUILD_ID,
      moduleBytes: 123,
      moduleSha256: MODULE_SHA256,
      receiptBytes: 456,
      receiptSha256: RECEIPT_SHA256,
    },
  }],
} = {}) {
  return Buffer.from(JSON.stringify({
    format: { name: "ferrite-server", major: 1, minor: 0 },
    buildId,
    files,
    routes,
  }));
}

const DEFAULT_MANIFEST_BYTES = manifestBytes();

function manifestBuildId(bytes = DEFAULT_MANIFEST_BYTES) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createCloudflareSsrHandler(options, bytes = DEFAULT_MANIFEST_BYTES) {
  return createCloudflareSsrHandlerBase({
    ...options,
    assetManifestSha256: manifestBuildId(bytes),
  });
}

function documentRouteModule(render, options) {
  const module = routeModule(render, options);
  module.documentModule = { default() {} };
  module.serverRuntime.renderDocumentModuleToPacket = async () => render();
  return module;
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

function assets(seen, response = new Response(DEFAULT_FALLBACK_BODY, {
  status: 200,
  headers: { "Content-Type": "text/html; charset=utf-8" },
}), buildId = BUILD_ID, manifestOverride) {
  const bytes = manifestOverride ?? (
    buildId === BUILD_ID
      ? DEFAULT_MANIFEST_BYTES
      : manifestBytes({ buildId })
  );
  return {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/ferrite-server.json") {
          return new Response(bytes, {
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
      fallbackBody: "tiny",
    },
  ];

  for (const scenario of scenarios) {
    const seen = [];
    const fallbackBody = scenario.fallbackBody ?? DEFAULT_FALLBACK_BODY;
    const bytes = manifestBytes({
      files: [fileRecord("docs/index.html", fallbackBody)],
    });
    const handler = createCloudflareSsrHandler({
      routes: [{
        module: routeModule(scenario.render),
      }],
      renderer: textRenderer(),
      responseDeadlineMs: scenario.responseDeadlineMs,
      maxPacketBytes: scenario.maxPacketBytes,
      maxHtmlBytes: scenario.maxHtmlBytes,
    }, bytes);
    const response = await handler.fetch(
      new Request("https://example.test/docs?private=1"),
      assets(seen, new Response(fallbackBody, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }), BUILD_ID, bytes),
    );
    assert.equal(response.status, 200, scenario.name);
    assert.equal(await response.text(), fallbackBody, scenario.name);
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
    assets([], new Response("missing", { status: 404 })),
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

test("counts the full-document prefix against the bounded HTML output", async () => {
  const prefix = "<!doctype html>\n";
  const html = "edge";
  const maxHtmlBytes = new TextEncoder().encode(`${prefix}${html}`).byteLength;
  let observedRendererLimit;
  const render = () => ({
    ferrite: "render-packet",
    version: 1,
    root: [0, html],
  });
  const handler = createCloudflareSsrHandler({
    routes: [{ module: documentRouteModule(render) }],
    renderer: {
      renderPacketJsonToHtml(_json, limit) {
        observedRendererLimit = limit;
        return html;
      },
    },
    maxHtmlBytes,
  });
  const response = await handler.fetch(
    new Request("https://example.test/docs"),
    assets([]),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `${prefix}${html}`);
  assert.equal(observedRendererLimit, new TextEncoder().encode(html).byteLength);

  const overSeen = [];
  const oneByteOver = createCloudflareSsrHandler({
    routes: [{ module: documentRouteModule(render) }],
    renderer: {
      renderPacketJsonToHtml() {
        return html;
      },
    },
    maxHtmlBytes: maxHtmlBytes - 1,
  });
  const over = await oneByteOver.fetch(
    new Request("https://example.test/docs"),
    assets(overSeen),
  );
  assert.equal(over.status, 200);
  assert.equal(over.headers.get("x-ferrite-render"), "static-fallback");
  assert.deepEqual(overSeen, [{ method: "GET", pathname: "/docs/index.html" }]);

  let rendererCalled = false;
  const seen = [];
  const exhausted = createCloudflareSsrHandler({
    routes: [{ module: documentRouteModule(render) }],
    renderer: {
      renderPacketJsonToHtml() {
        rendererCalled = true;
        return html;
      },
    },
    maxHtmlBytes: new TextEncoder().encode(prefix).byteLength,
  });
  const fallback = await exhausted.fetch(
    new Request("https://example.test/docs"),
    assets(seen),
  );
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("x-ferrite-render"), "static-fallback");
  assert.equal(rendererCalled, false);
  assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }]);
});

test("fails closed when route code and static assets do not share one build identity", async () => {
  let renders = 0;
  const createHandler = (bytes = DEFAULT_MANIFEST_BYTES) =>
    createCloudflareSsrHandler({
      routes: [{
        module: routeModule(() => {
          renders += 1;
          return { ferrite: "render-packet", version: 1, root: [0, "dynamic"] };
        }),
      }],
      renderer: textRenderer(),
    }, bytes);
  const manifestEnvironment = (bytes) => ({
    ASSETS: {
      async fetch() {
        return new Response(bytes);
      },
    },
  });

  const wrongBuild = manifestBytes({ buildId: `sha256:${"e".repeat(64)}` });
  const wrongFallback = manifestBytes({
    routes: [{
      path: "/docs",
      prerendered: { "/docs": "private.html" },
      observedActions: [],
      cloudflare: {
        path: "/docs",
        sourceBuildId: BUILD_ID,
        metadataBuildId: METADATA_BUILD_ID,
        moduleBuildId: MODULE_BUILD_ID,
        moduleBytes: 123,
        moduleSha256: MODULE_SHA256,
        receiptBytes: 456,
        receiptSha256: RECEIPT_SHA256,
      },
    }],
  });
  const wrongSource = manifestBytes({
    routes: [{
      path: "/docs",
      prerendered: { "/docs": "docs/index.html" },
      observedActions: [],
      cloudflare: {
        path: "/docs",
        sourceBuildId: `sha256:${"e".repeat(64)}`,
        metadataBuildId: METADATA_BUILD_ID,
        moduleBuildId: MODULE_BUILD_ID,
        moduleBytes: 123,
        moduleSha256: MODULE_SHA256,
        receiptBytes: 456,
        receiptSha256: RECEIPT_SHA256,
      },
    }],
  });
  const wrongMetadata = manifestBytes({
    routes: [{
      path: "/docs",
      prerendered: { "/docs": "docs/index.html" },
      observedActions: [],
      cloudflare: {
        path: "/docs",
        sourceBuildId: BUILD_ID,
        metadataBuildId: `sha256:${"f".repeat(64)}`,
        moduleBuildId: MODULE_BUILD_ID,
        moduleBytes: 123,
        moduleSha256: MODULE_SHA256,
        receiptBytes: 456,
        receiptSha256: RECEIPT_SHA256,
      },
    }],
  });
  const duplicateRoute = manifestBytes({
    routes: [
      JSON.parse(DEFAULT_MANIFEST_BYTES.toString("utf8")).routes[0],
      JSON.parse(DEFAULT_MANIFEST_BYTES.toString("utf8")).routes[0],
    ],
  });
  const fallbackFile = fileRecord("docs/index.html", DEFAULT_FALLBACK_BODY);
  const missingFallbackFile = manifestBytes({ files: [] });
  const duplicateFallbackFile = manifestBytes({
    files: [fallbackFile, fallbackFile],
  });
  const malformedFallbackFile = manifestBytes({
    files: [{ ...fallbackFile, size: -1 }],
  });
  const cases = [
    {
      handler: createHandler(),
      env: manifestEnvironment(Buffer.concat([DEFAULT_MANIFEST_BYTES, Buffer.from(" ")])),
    },
    {
      handler: createHandler(wrongBuild),
      env: manifestEnvironment(wrongBuild),
    },
    {
      handler: createHandler(wrongFallback),
      env: manifestEnvironment(wrongFallback),
    },
    {
      handler: createHandler(wrongSource),
      env: manifestEnvironment(wrongSource),
    },
    {
      handler: createHandler(wrongMetadata),
      env: manifestEnvironment(wrongMetadata),
    },
    {
      handler: createHandler(duplicateRoute),
      env: manifestEnvironment(duplicateRoute),
    },
    {
      handler: createHandler(missingFallbackFile),
      env: manifestEnvironment(missingFallbackFile),
    },
    {
      handler: createHandler(duplicateFallbackFile),
      env: manifestEnvironment(duplicateFallbackFile),
    },
    {
      handler: createHandler(malformedFallbackFile),
      env: manifestEnvironment(malformedFallbackFile),
    },
    {
      handler: createHandler(),
      env: {
      ASSETS: {
        async fetch() {
          return new Response("x".repeat((64 * 1024) + 1));
        },
      },
    },
    },
  ];
  for (const { handler, env } of cases) {
    const response = await handler.fetch(
      new Request("https://example.test/docs"),
      env,
    );
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Internal server error");
  }
  assert.equal(renders, 0);
});

test("fails closed when fallback bytes differ from the pinned manifest file identity", async () => {
  const tamperedFallbackBody = "tamper docs";
  assert.equal(
    Buffer.byteLength(tamperedFallbackBody),
    Buffer.byteLength(DEFAULT_FALLBACK_BODY),
    "The tamper fixture must isolate the SHA-256 check from the size check.",
  );
  const handler = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => {
        throw new Error("render failed");
      }),
    }],
    renderer: textRenderer(),
  });
  for (const method of ["GET", "HEAD"]) {
    const seen = [];
    const response = await handler.fetch(
      new Request("https://example.test/docs", { method }),
      assets(seen, new Response(tamperedFallbackBody, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })),
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), method === "HEAD" ? "" : "Internal server error");
    assert.equal(response.headers.get("x-ferrite-render"), null);
    assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }]);
  }

  const seen = [];
  const valid = await handler.fetch(
    new Request("https://example.test/docs", { method: "HEAD" }),
    assets(seen),
  );
  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), "");
  assert.equal(valid.headers.get("x-ferrite-render"), "static-fallback");
  assert.deepEqual(seen, [{ method: "GET", pathname: "/docs/index.html" }]);
});

test("bounds manifest hashing before rollback can receive a fresh deadline", async () => {
  const originalDigest = globalThis.crypto.subtle.digest;
  let digestCalls = 0;
  let fallbackFetches = 0;
  globalThis.crypto.subtle.digest = async function delayedDigest(...args) {
    digestCalls += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    return originalDigest.apply(this, args);
  };
  try {
    const handler = createCloudflareSsrHandler({
      routes: [{
        module: routeModule(
          () => ({ ferrite: "render-packet", version: 1, root: [0, "unused"] }),
        ),
      }],
      renderer: textRenderer(),
      responseDeadlineMs: 5,
      shouldRender: () => false,
    });
    const response = await handler.fetch(
      new Request("https://example.test/docs"),
      {
        ASSETS: {
          async fetch(request) {
            if (new URL(request.url).pathname === "/ferrite-server.json") {
              return new Response(DEFAULT_MANIFEST_BYTES);
            }
            fallbackFetches += 1;
            return new Response("static docs", {
              headers: { "Content-Type": "text/html" },
            });
          },
        },
      },
    );
    assert.equal(response.status, 504);
    assert.equal(await response.text(), "Gateway timeout");
    assert.equal(digestCalls, 1);
    assert.equal(fallbackFetches, 0);
  } finally {
    globalThis.crypto.subtle.digest = originalDigest;
  }
});

test("bounds fallback hashing against the fresh rollback deadline", async () => {
  const originalDigest = globalThis.crypto.subtle.digest;
  let digestCalls = 0;
  let fallbackFetches = 0;
  globalThis.crypto.subtle.digest = async function delayedFallbackDigest(...args) {
    digestCalls += 1;
    if (digestCalls === 2) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    return originalDigest.apply(this, args);
  };
  try {
    const handler = createCloudflareSsrHandler({
      routes: [{
        module: routeModule(
          () => ({ ferrite: "render-packet", version: 1, root: [0, "unused"] }),
        ),
      }],
      renderer: textRenderer(),
      responseDeadlineMs: 100,
      shouldRender: () => false,
    });
    const response = await handler.fetch(
      new Request("https://example.test/docs"),
      {
        ASSETS: {
          async fetch(request) {
            if (new URL(request.url).pathname === "/ferrite-server.json") {
              return new Response(DEFAULT_MANIFEST_BYTES);
            }
            fallbackFetches += 1;
            return new Response(DEFAULT_FALLBACK_BODY, {
              headers: { "Content-Type": "text/html" },
            });
          },
        },
      },
    );
    assert.equal(response.status, 504);
    assert.equal(await response.text(), "Gateway timeout");
    assert.equal(digestCalls, 2);
    assert.equal(fallbackFetches, 1);
  } finally {
    globalThis.crypto.subtle.digest = originalDigest;
  }
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
          return new Response(DEFAULT_MANIFEST_BYTES);
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

test("buffers fallback HTML and fails closed on stream errors, stalls, and invalid lengths", async () => {
  const fallbackEnvironment = (makeResponse) => ({
    ASSETS: {
      async fetch(request) {
        if (new URL(request.url).pathname === "/ferrite-server.json") {
          return new Response(DEFAULT_MANIFEST_BYTES);
        }
        return makeResponse();
      },
    },
  });
  const handler = (options = {}) => createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => {
        throw new Error("render failed");
      }),
    }],
    renderer: textRenderer(),
    ...options,
  });

  const errored = await handler().fetch(
    new Request("https://example.test/docs"),
    fallbackEnvironment(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<!doctype html>"));
        controller.error(new Error("stream failed"));
      },
    }), {
      headers: { "Content-Type": "text/html" },
    })),
  );
  assert.equal(errored.status, 500);
  assert.equal(await errored.text(), "Internal server error");

  let stalledCanceled = false;
  const stalled = await handler({ responseDeadlineMs: 10 }).fetch(
    new Request("https://example.test/docs"),
    fallbackEnvironment(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<!doctype html>"));
      },
      cancel() {
        stalledCanceled = true;
        return new Promise(() => {});
      },
    }), {
      headers: { "Content-Type": "text/html" },
    })),
  );
  assert.equal(stalled.status, 504);
  assert.equal(await stalled.text(), "Gateway timeout");
  assert.equal(stalledCanceled, true);

  let zeroBytePulls = 0;
  const zeroByteFlood = await handler({ responseDeadlineMs: 20 }).fetch(
    new Request("https://example.test/docs"),
    fallbackEnvironment(() => new Response(new ReadableStream({
      pull(controller) {
        zeroBytePulls += 1;
        if (zeroBytePulls < 1_000_000) {
          controller.enqueue(new Uint8Array());
        } else {
          controller.close();
        }
      },
    }), {
      headers: { "Content-Type": "text/html" },
    })),
  );
  assert.equal(zeroByteFlood.status, 504);
  assert.equal(await zeroByteFlood.text(), "Gateway timeout");
  assert.ok(zeroBytePulls > 0);
  assert.ok(zeroBytePulls < 1_000_000);

  const oversized = await handler({ maxHtmlBytes: 4 }).fetch(
    new Request("https://example.test/docs"),
    fallbackEnvironment(() => new Response("<!doctype html>", {
      headers: { "Content-Type": "text/html" },
    })),
  );
  assert.equal(oversized.status, 500);
  assert.equal(await oversized.text(), "Internal server error");

  const truncated = await handler().fetch(
    new Request("https://example.test/docs"),
    fallbackEnvironment(() => new Response("short", {
      headers: {
        "Content-Length": "10",
        "Content-Type": "text/html",
      },
    })),
  );
  assert.equal(truncated.status, 500);
  assert.equal(await truncated.text(), "Internal server error");
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

  for (const method of ["GET", "HEAD"]) {
    for (const response of [
      new Response('{"private":"fallback"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response("untyped fallback", { status: 200 }),
    ]) {
      const rejected = await handler.fetch(
        new Request("https://example.test/docs", { method }),
        assets([], response),
      );
      assert.equal(rejected.status, 500);
      assert.equal(await rejected.text(), method === "HEAD" ? "" : "Internal server error");
    }
  }

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
    [2, "FORM", { ACTION: "/_ferrite/action" }, [[0, "Save"]]],
    [2, "section", {}, [[2, "input", { name: "__ferrite_action", value: "save" }, []]]],
    [2, "section", {}, [[2, "INPUT", { NAME: "__ferrite_action", value: "save" }, []]]],
    [2, "button", { FORMAction: "/_ferrite/action" }, [[0, "Save"]]],
    [2, "input", { formaction: "/_ferrite/action", type: "submit" }, []],
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

test("resolves HTML Accept ranges by specificity and quality", async () => {
  const worker = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, "request"],
      })),
    }],
    renderer: textRenderer(),
  });
  const env = assets([]);
  for (const [accept, status] of [
    ["text/*", 200],
    ["text/html;q=0.5", 200],
    ["text/html;q=0, */*;q=1", 406],
    ["text/html;q=0, text/*;q=1", 406],
    ["text/html;q=bogus, */*;q=1", 406],
  ]) {
    const response = await worker.fetch(
      new Request("https://example.test/docs", { headers: { Accept: accept } }),
      env,
    );
    assert.equal(response.status, status, accept);
  }
});

test("documents Fetch normalization of a raw single-encoded dot segment", async () => {
  const request = new Request("https://example.test/%2e%2e/docs");
  assert.equal(request.url, "https://example.test/docs");
  const worker = createCloudflareSsrHandler({
    routes: [{
      module: routeModule(() => ({
        ferrite: "render-packet",
        version: 1,
        root: [0, "request"],
      })),
    }],
    renderer: textRenderer(),
  });
  const response = await worker.fetch(request, assets([]));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ferrite-render"), "request");
});

test("rejects routes outside the initial static, action-free Worker compatibility tier", () => {
  const base = {
    module: routeModule(() => ({ ferrite: "render-packet", version: 1, root: [0, "ok"] })),
  };
  const renderer = textRenderer();

  assert.throws(
    () => createCloudflareSsrHandlerBase({
      routes: [base],
      renderer,
      assetManifestSha256: "not-a-digest",
    }),
    /exact SHA-256 identity/,
  );
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
  const withoutIdentity = {
    module: { ...base.module },
  };
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
          cloudflare: {
            ...base.module.cloudflare,
            version: 1,
          },
        },
      }],
      renderer,
    }),
    /generated edge identity/,
  );
  assert.throws(
    () => createCloudflareSsrHandler({
      routes: [{
        module: {
          ...base.module,
          cloudflare: {
            ...base.module.cloudflare,
            metadataBuildId: "not-a-digest",
          },
        },
      }],
      renderer,
    }),
    /invalid metadata build identity/,
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
