import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright-core";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromeExecutable = process.env.FERRITE_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("server payload navigator handles prefetch, stream navigation, and popstate in Chromium", async (t) => {
  if (!existsSync(chromeExecutable)) {
    t.skip(`Chrome executable not found at ${chromeExecutable}`);
    return;
  }

  const project = await createPayloadNavigationFixture();
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });

  const { server, origin, requests } = await servePayloadNavigationFixture(join(project, "public"));
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  t.after(async () => {
    await page.close();
  });

  const response = await page.goto(origin, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  await page.waitForFunction(() => Boolean(globalThis.ferriteRuntimeTest));
  await page.getByRole("heading", { name: "Old route" }).waitFor();

  await page.hover("#prefetch-link");
  await waitForRequest(requests, "/posts/prefetched?__ferrite_payload=server");

  await page.evaluate(() => {
    globalThis.ferriteRuntimeTest.malformedNavigation = globalThis.ferriteRuntimeTest.navigator
      .navigate("/posts/malformed")
      .then(
        () => "resolved",
        (error) => (error instanceof Error ? error.message : String(error)),
      );
  });
  await waitForRequest(requests, "/posts/malformed?__ferrite_payload=server");
  const malformedError = await page.evaluate(() => globalThis.ferriteRuntimeTest.malformedNavigation);
  assert.match(malformedError, /unsupported opcode bad/);
  await page.waitForFunction(() =>
    Boolean(globalThis.ferriteRuntimeTest?.errors.some((message) => message.includes("unsupported opcode bad"))),
  );
  await page.getByRole("heading", { name: "Old route" }).waitFor();
  assert.equal(page.url(), `${origin}/`);
  assert.equal(await page.title(), "Old title");
  assert.equal(await page.locator("#ferrite-root").getAttribute("data-route"), "/posts/old");

  await page.click("#prefetch-link");
  await page.getByRole("heading", { name: "Prefetched route" }).waitFor();
  await page.getByText("Loaded prefetched details").waitFor();
  assert.equal(page.url(), `${origin}/posts/prefetched`);
  assert.equal(await page.title(), "Prefetched title");
  assert.equal(
    requests.filter((request) => request === "/posts/prefetched?__ferrite_payload=server").length,
    1,
  );

  await page.evaluate(() => {
    globalThis.ferriteRuntimeTest.streamNavigation =
      globalThis.ferriteRuntimeTest.navigator.navigate("/posts/stream");
  });
  await waitForRequest(requests, "/posts/stream?__ferrite_payload=stream");
  await page.getByText("Loading stream details").waitFor();
  await page.getByText("Loaded stream details").waitFor();
  await page.evaluate(() => globalThis.ferriteRuntimeTest.streamNavigation);
  assert.equal(page.url(), `${origin}/posts/stream`);
  assert.equal(await page.title(), "Stream title");
  assert(requests.includes("/posts/stream?__ferrite_payload=stream"));

  const beforeBackRequests = requests.length;
  await page.evaluate(() => {
    history.back();
  });
  await waitForRequest(requests, "/posts/prefetched?__ferrite_payload=stream", {
    after: beforeBackRequests,
  });
  await page.getByRole("heading", { name: "Prefetched route" }).waitFor();
  await page.getByText("Loaded prefetched details").waitFor();
  assert.equal(page.url(), `${origin}/posts/prefetched`);
  assert.equal(await page.title(), "Prefetched title");

  const beforeForwardRequests = requests.length;
  await page.evaluate(() => {
    history.forward();
  });
  await waitForRequest(requests, "/posts/stream?__ferrite_payload=stream", {
    after: beforeForwardRequests,
  });
  await page.getByRole("heading", { name: "Stream route" }).waitFor();
  await page.getByText("Loaded stream details").waitFor();
  assert.equal(page.url(), `${origin}/posts/stream`);
  assert.equal(await page.title(), "Stream title");
  assert.deepEqual(
    pageErrors.map((error) => error.message),
    [],
  );
});

test("server payload navigator falls back from malformed clicked payloads in Chromium", async (t) => {
  if (!existsSync(chromeExecutable)) {
    t.skip(`Chrome executable not found at ${chromeExecutable}`);
    return;
  }

  const project = await createPayloadNavigationFixture();
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });

  const { server, origin, requests } = await servePayloadNavigationFixture(join(project, "public"));
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  t.after(async () => {
    await page.close();
  });

  const response = await page.goto(origin, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  await page.waitForFunction(() => Boolean(globalThis.ferriteRuntimeTest));
  await page.getByRole("heading", { name: "Old route" }).waitFor();

  await page.click("#malformed-link");
  await waitForRequest(requests, "/posts/malformed?__ferrite_payload=server");
  await page.waitForURL(`${origin}/posts/malformed`);
  await page.getByRole("heading", { name: "Malformed fallback route" }).waitFor();
  assert.equal(await page.title(), "Malformed fallback title");
  assert.deepEqual(
    pageErrors.map((error) => error.message),
    [],
  );
});

async function createPayloadNavigationFixture() {
  const project = await mkdtemp(join(tmpdir(), "ferrite-browser-payload-nav-"));
  const publicDir = join(project, "public");
  await mkdir(join(project, "node_modules", "@ferrite"), { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await symlink(join(repoRoot, "packages/runtime"), join(project, "node_modules", "@ferrite", "runtime"), "dir");
  await symlink(join(repoRoot, "packages/protocol"), join(project, "node_modules", "@ferrite", "protocol"), "dir");
  await writeFile(join(project, "package.json"), JSON.stringify({ type: "module" }));
  const entryFile = join(project, "app.mjs");
  await writeFile(
    entryFile,
    [
      `import { createElement } from "@ferrite/runtime";`,
      `import { createServerPayloadNavigator, mount } from "@ferrite/runtime/dom";`,
      ``,
      `const container = document.getElementById("app");`,
      `const root = mount(`,
      `  createElement("div", { id: "ferrite-root", "data-route": "/posts/old" },`,
      `    createElement("h1", null, "Old route"),`,
      `    createElement("a", { href: "/posts/prefetched", id: "prefetch-link" }, "Prefetch route"),`,
      `    createElement("a", { href: "/posts/stream", id: "stream-link" }, "Stream route"),`,
      `    createElement("a", { href: "/posts/malformed", id: "malformed-link" }, "Malformed route"),`,
      `  ),`,
      `  container,`,
      `);`,
      `const errors = [];`,
      `const navigator = createServerPayloadNavigator(root, {`,
      `  prefetch: true,`,
      `  stream: true,`,
      `  onError(error) { errors.push(error instanceof Error ? error.message : String(error)); },`,
      `});`,
      `globalThis.ferriteRuntimeTest = { navigator, errors };`,
      ``,
    ].join("\n"),
  );
  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: join(publicDir, "app.js"),
    logLevel: "silent",
  });
  await writeFile(
    join(publicDir, "index.html"),
    [
      `<!doctype html>`,
      `<html>`,
      `<head><title>Old title</title></head>`,
      `<body>`,
      `<main id="app"></main>`,
      `<script type="module" src="/app.js"></script>`,
      `</body>`,
      `</html>`,
      ``,
    ].join("\n"),
  );
  return project;
}

async function servePayloadNavigationFixture(publicDir) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(`${url.pathname}${url.search}`);

      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/posts/prefetched" && url.searchParams.get("__ferrite_payload") === "server") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(serverPayloadPacket("prefetched")));
        return;
      }

      if (url.pathname === "/posts/malformed" && url.searchParams.get("__ferrite_payload") === "server") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ferrite: "server-payload", version: 1, shell: ["bad"], clientReferences: [], chunks: [] }));
        return;
      }

      if (url.pathname === "/posts/malformed" && !url.searchParams.has("__ferrite_payload")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          [
            `<!doctype html>`,
            `<html>`,
            `<head><title>Malformed fallback title</title></head>`,
            `<body><main><h1>Malformed fallback route</h1></main></body>`,
            `</html>`,
            ``,
          ].join("\n"),
        );
        return;
      }

      if (url.pathname === "/posts/prefetched" && url.searchParams.get("__ferrite_payload") === "stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        response.write(`${JSON.stringify(serverPayloadStreamFrame("prefetched-shell"))}\n`);
        setTimeout(() => {
          response.end(`${JSON.stringify(serverPayloadStreamFrame("prefetched-chunk"))}\n`);
        }, 50);
        return;
      }

      if (url.pathname === "/posts/stream" && url.searchParams.get("__ferrite_payload") === "stream") {
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        response.write(`${JSON.stringify(serverPayloadStreamFrame("shell"))}\n`);
        setTimeout(() => {
          response.end(`${JSON.stringify(serverPayloadStreamFrame("chunk"))}\n`);
        }, 500);
        return;
      }

      const file = resolvePublicFile(publicDir, url.pathname);
      if (!file) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }
      response.writeHead(200, { "content-type": contentType(file) });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}`, requests };
}

function serverPayloadPacket(route) {
  return {
    ferrite: "server-payload",
    version: 1,
    shell: documentPayloadShell({
      route: "/posts/prefetched",
      title: "Prefetched title",
      heading: "Prefetched route",
      fallback: "Loading prefetched details",
      linkHref: "/posts/stream",
      linkId: "stream-link",
      linkText: "Stream route",
    }),
    clientReferences: [],
    chunks: [
      {
        id: `${route}-details`,
        root: [2, "strong", {}, [[0, "Loaded prefetched details"]]],
        clientReferences: [],
      },
    ],
  };
}

function serverPayloadStreamFrame(kind) {
  if (kind === "prefetched-shell") {
    return {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "shell",
      shell: documentPayloadShell({
        route: "/posts/prefetched",
        title: "Prefetched title",
        heading: "Prefetched route",
        fallback: "Loading prefetched details",
        linkHref: "/posts/stream",
        linkId: "stream-link",
        linkText: "Stream route",
      }),
      clientReferences: [],
    };
  }

  if (kind === "prefetched-chunk") {
    return {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "chunk",
      chunk: {
        id: "prefetched-details",
        root: [2, "strong", {}, [[0, "Loaded prefetched details"]]],
        clientReferences: [],
      },
    };
  }

  if (kind === "shell") {
    return {
      ferrite: "server-payload-frame",
      version: 1,
      kind: "shell",
      shell: documentPayloadShell({
        route: "/posts/stream",
        title: "Stream title",
        heading: "Stream route",
        fallback: "Loading stream details",
      }),
      clientReferences: [],
    };
  }

  return {
    ferrite: "server-payload-frame",
    version: 1,
    kind: "chunk",
    chunk: {
      id: "stream-details",
      root: [2, "strong", {}, [[0, "Loaded stream details"]]],
      clientReferences: [],
    },
  };
}

function documentPayloadShell({ route, title, heading, fallback, linkHref, linkId, linkText }) {
  const children = [
    [2, "h1", {}, [[0, heading]]],
    [2, "div", { "data-ferrite-suspense-boundary": route.includes("stream") ? "stream-details" : "prefetched-details" }, [[0, fallback]]],
  ];
  if (linkHref) {
    children.push([2, "a", { href: linkHref, id: linkId }, [[0, linkText]]]);
  }

  return [
    2,
    "html",
    {},
    [
      [2, "head", {}, [[2, "title", {}, [[0, title]]]]],
      [2, "body", {}, [[2, "div", { id: "ferrite-root", "data-route": route }, children]]],
    ],
  ];
}

function resolvePublicFile(publicDir, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(publicDir, relativePath);
  if (!candidate.startsWith(publicDir) || !isFile(candidate)) {
    return null;
  }
  return candidate;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function contentType(file) {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function waitForRequest(requests, expected, options = {}) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (requests.slice(options.after ?? 0).includes(expected)) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for request ${expected}; saw ${requests.join(", ")}`);
}
