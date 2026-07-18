import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromeExecutable = process.env.FERRITE_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("command capture reports spawn failures", async () => {
  const missingCommand = join(tmpdir(), `ferrite-missing-command-${process.pid}-${Date.now()}`);
  await assert.rejects(
    runCapture(missingCommand, [], { cwd: repoRoot }),
    /failed to start:.*ENOENT/,
  );
});

test("command capture waits for output drainage", async () => {
  const expectedBytes = 256 * 1024;
  const { stdout } = await runCapture(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${expectedBytes}))`],
    { cwd: repoRoot },
  );

  assert.equal(Buffer.byteLength(stdout), expectedBytes);
});

test("shutdown reuses terminal observation installed at spawn time", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const terminal = captureChildTerminal(child);
  const logs = captureChildOutput(child);
  await terminal;

  await stopChild(child, terminal, logs);
});

test("shutdown result accepts Windows forced SIGTERM semantics", () => {
  assert.equal(isExpectedChildShutdown({ code: 0, signal: null }, "darwin"), true);
  assert.equal(isExpectedChildShutdown({ code: null, signal: "SIGTERM" }, "win32"), true);
  assert.equal(isExpectedChildShutdown({ code: null, signal: "SIGTERM" }, "darwin"), false);
  assert.equal(isExpectedChildShutdown({ code: 1, signal: null }, "win32"), false);
});

test("browser cleanup still stops the server when browser close rejects", async (t) => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const terminal = captureChildTerminal(child);
  const logs = captureChildOutput(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await terminal;
  });
  await new Promise((resolveReady, rejectReady) => {
    child.once("error", rejectReady);
    child.stdout.once("data", resolveReady);
  });

  await assert.rejects(
    closeOwnedBrowserAndServer(
      { close: async () => { throw new Error("browser close failed"); } },
      child,
      terminal,
      logs,
    ),
    /browser close failed/,
  );
  assert.equal(isExpectedChildShutdown(await terminal), true);
});

test("generated action form bootstrap submits to a fixture server for route, island, and server-only assets", async (t) => {
  if (!existsSync(chromeExecutable)) {
    t.skip(`Chrome executable not found at ${chromeExecutable}`);
    return;
  }

  const project = await createBrowserFixtureProject();
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });

  await run("cargo", ["run", "-p", "ferrite-cli", "--", "build", "--project", project], { cwd: repoRoot });

  const { server, origin, receivedActions } = await serveBuild(join(project, ".ferrite/build"));
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
  t.after(async () => {
    await browser.close();
  });

  await assertEnhancedSubmission(browser, origin, receivedActions, {
    path: "/client-action",
    heading: "Client action",
    title: "Client title",
    action: "app/client-action/page.tsx#saveClient",
    scriptExpectation: /\/_ferrite\/static\/route-client-action\.[a-f0-9]{16}\.js/,
  });
  await assertEnhancedSubmission(browser, origin, receivedActions, {
    path: "/island-action",
    heading: "Island action",
    title: "Island title",
    action: "app/island-action/ActionIsland.tsx#saveIsland",
    scriptExpectation: /\/_ferrite\/static\/client-reference-app-island-action-ActionIsland-tsx-default\.[a-f0-9]{16}\.js/,
  });
  await assertEnhancedSubmission(browser, origin, receivedActions, {
    path: "/server-action",
    heading: "Server-only action",
    title: "Server title",
    action: "app/server-action/page.tsx#saveServer",
    scriptExpectation: /\/_ferrite\/static\/route-server-action-action-bootstrap\.[a-f0-9]{16}\.js/,
    absentScriptExpectation: /\/_ferrite\/static\/route-server-action\.[a-f0-9]{16}\.js/,
  });
});

test("production serve handles browser hydration, payloads, and action success and failure", { timeout: 90_000 }, async (t) => {
  if (!existsSync(chromeExecutable)) {
    t.skip(`Chrome executable not found at ${chromeExecutable}`);
    return;
  }

  const exampleProject = join(repoRoot, "examples/basic");
  const metadata = JSON.parse(
    (
      await runCapture("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
        cwd: repoRoot,
      })
    ).stdout,
  );
  const ferriteBinary = join(
    metadata.target_directory,
    "debug",
    process.platform === "win32" ? "ferrite.exe" : "ferrite",
  );
  const proofRoot = await mkdtemp(join(tmpdir(), "ferrite-production-browser-"));
  const artifact = join(proofRoot, "build");
  const typesOut = join(proofRoot, "types/routes.d.ts");
  t.after(async () => {
    await rm(proofRoot, { recursive: true, force: true });
  });

  await run("cargo", ["build", "-p", "ferrite-cli"], { cwd: repoRoot });
  await run(
    ferriteBinary,
    ["build", "--project", exampleProject, "--out", artifact, "--types-out", typesOut],
    { cwd: repoRoot },
  );

  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const csrfToken = "ferrite-production-browser-proof";
  const server = spawn(
    ferriteBinary,
    [
      "serve",
      "--project",
      exampleProject,
      "--artifact",
      artifact,
      "--page-renderer",
      join(repoRoot, "packages/runtime/bin/render-artifact.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--server-action-csrf-token-env",
      "FERRITE_TEST_ACTION_CSRF",
      "--server-action-replay-ttl-ms",
      "60000",
      "--access-log",
      "json",
      "--action-log",
      "json",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, FERRITE_TEST_ACTION_CSRF: csrfToken },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const serverTerminal = captureChildTerminal(server);
  const logs = captureChildOutput(server);

  let browser;
  try {
    await waitForServer(origin, server, logs);
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const fetchImpl = globalThis.fetch.bind(globalThis);
      globalThis.__ferriteActionResponses = [];
      globalThis.fetch = async (...args) => {
        const response = await fetchImpl(...args);
        const requestUrl = new URL(
          typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url,
          globalThis.location.href,
        );
        if (requestUrl.pathname === "/_ferrite/action") {
          globalThis.__ferriteActionResponses.push({
            status: response.status,
            body: await response.clone().text(),
          });
        }
        return response;
      };
    });

    const documentResponse = await page.goto(`${origin}/posts/alpha`, { waitUntil: "networkidle" });
    assert.equal(documentResponse?.status(), 200);
    assert.equal(await page.title(), "Post alpha");
    await page.getByRole("heading", { name: "Post alpha" }).waitFor();
    assert.equal(await page.locator('input[name="title"]').inputValue(), "Post alpha");
    assert.deepEqual(
      await page.locator("form").first().locator('input[type="hidden"]').evaluateAll((inputs) =>
        Object.fromEntries(inputs.map((input) => [input.name, input.value])),
      ),
      {
        __ferrite_action: "app/posts/[id]/page.tsx#savePost",
        __ferrite_route: "/posts/alpha",
        __ferrite_csrf: csrfToken,
        __ferrite_nonce: await page.locator('input[name="__ferrite_nonce"]').inputValue(),
      },
    );
    assert.ok((await page.locator('input[name="__ferrite_nonce"]').inputValue()).length > 0);

    await page.getByRole("button", { name: "Like alpha: 0" }).click();
    await page.getByRole("button", { name: "Like alpha: 1" }).waitFor();

    const payloads = await page.evaluate(async () => {
      const payloadResponse = await fetch("/posts/beta?__ferrite_payload=server");
      const streamResponse = await fetch("/posts/beta?__ferrite_payload=stream");
      return {
        payload: {
          status: payloadResponse.status,
          contentType: payloadResponse.headers.get("content-type"),
          body: await payloadResponse.json(),
        },
        stream: {
          status: streamResponse.status,
          contentType: streamResponse.headers.get("content-type"),
          frames: (await streamResponse.text())
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        },
      };
    });
    assert.equal(payloads.payload.status, 200);
    assert.match(payloads.payload.contentType, /^application\/vnd\.ferrite\.server-payload\+json/);
    assert.equal(payloads.payload.body.ferrite, "server-payload");
    assert.equal(payloads.payload.body.version, 1);
    assert.equal(payloads.stream.status, 200);
    assert.match(
      payloads.stream.contentType,
      /^application\/vnd\.ferrite\.server-payload-stream\+jsonl/,
    );
    assert.ok(payloads.stream.frames.length >= 1);
    assert.equal(payloads.stream.frames[0].ferrite, "server-payload-frame");
    assert.equal(payloads.stream.frames[0].version, 1);
    assert.equal(payloads.stream.frames[0].kind, "shell");

    const betaResponse = await page.goto(`${origin}/posts/beta`, { waitUntil: "networkidle" });
    assert.equal(betaResponse?.status(), 200);
    assert.equal(await page.title(), "Post beta");
    await page.getByRole("heading", { name: "Post beta" }).waitFor();

    await page.goto(`${origin}/posts/alpha`, { waitUntil: "networkidle" });
    await page.locator('input[name="title"]').fill("Browser production title");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => globalThis.__ferriteActionResponses.length === 1);
    assert.deepEqual(JSON.parse((await capturedActionResponses(page))[0].body), {
      ferrite: "server-action-response",
      version: 1,
      status: "ok",
      data: {
        ok: true,
        routePath: "/posts/alpha",
        title: "Browser production title",
      },
    });
    assert.equal(page.url(), `${origin}/posts/alpha`);

    await page.reload({ waitUntil: "networkidle" });
    await page.locator('input[name="__ferrite_action"]').evaluate((input) => {
      input.value = "app/posts/[id]/page.tsx#missing";
    });
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => globalThis.__ferriteActionResponses.length === 1);
    const rejectedResponse = (await capturedActionResponses(page))[0];
    assert.equal(rejectedResponse.status, 404);
    assert.match(rejectedResponse.body, /No Ferrite server action .*#missing.* was registered/);
    assert.equal(page.url(), `${origin}/posts/alpha`);
    await page.getByRole("heading", { name: "Post alpha" }).waitFor();
    await page.getByRole("button", { name: "Like alpha: 0" }).click();
    await page.getByRole("button", { name: "Like alpha: 1" }).waitFor();

    await page.close();
  } finally {
    await closeOwnedBrowserAndServer(browser, server, serverTerminal, logs);
  }

  assert.doesNotMatch(`${logs.stdout}\n${logs.stderr}`, new RegExp(csrfToken));
  const actionEntries = parseJsonLogEntries(logs.stderr).filter((entry) => "action_id" in entry);
  assert.ok(
    actionEntries.some(
      (entry) =>
        entry.action_id === "app/posts/[id]/page.tsx#savePost" &&
        entry.route_path === "/posts/alpha" &&
        entry.status === 200 &&
        entry.outcome === "accepted",
    ),
  );
  assert.ok(
    actionEntries.some(
      (entry) =>
        entry.action_id === "app/posts/[id]/page.tsx#missing" &&
        entry.route_path === "/posts/alpha" &&
        entry.status === 404 &&
        entry.outcome === "rejected",
    ),
  );
});

async function assertEnhancedSubmission(browser, origin, receivedActions, route) {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${origin}${route.path}`, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200);
    const html = await page.content();
    assert.match(html, route.scriptExpectation);
    if (route.absentScriptExpectation) {
      assert.doesNotMatch(html, route.absentScriptExpectation);
    }

    await page.getByRole("button", { name: "Save" }).click();
    const request = await receivedActions.next({ timeoutMs: 5000, label: route.path });

    assert.equal(page.url(), `${origin}${route.path}`);
    await page.getByRole("heading", { name: route.heading }).waitFor();
    assert.deepEqual(request, {
      path: "/_ferrite/action",
      method: "POST",
      fields: {
        __ferrite_action: [route.action],
        __ferrite_route: [route.path],
        title: [route.title],
      },
    });
  } finally {
    await page.close();
  }
}

async function capturedActionResponses(page) {
  return page.evaluate(() => globalThis.__ferriteActionResponses);
}

async function createBrowserFixtureProject() {
  const project = await mkdtemp(join(tmpdir(), "ferrite-browser-actions-"));
  await mkdir(join(project, "app/client-action"), { recursive: true });
  await mkdir(join(project, "app/island-action"), { recursive: true });
  await mkdir(join(project, "app/server-action"), { recursive: true });
  await mkdir(join(project, "node_modules/@ferrite"), { recursive: true });
  await symlink(join(repoRoot, "packages/runtime"), join(project, "node_modules/@ferrite/runtime"), "dir");
  await symlink(join(repoRoot, "packages/protocol"), join(project, "node_modules/@ferrite/protocol"), "dir");
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "@ferrite/runtime": "workspace:*" } }, null, 2),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "@ferrite/runtime",
          module: "ES2022",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
        },
        include: ["app/**/*.tsx", ".ferrite/types/**/*.d.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(project, "app/document.tsx"),
    `import type { Child } from "@ferrite/runtime";

export default function Document({ children, head }: { children: Child; head: Child }) {
  return (
    <html>
      <head>{head}</head>
      <body>{children}</body>
    </html>
  );
}
`,
  );
  await writeFile(
    join(project, "app/client-action/page.tsx"),
    `"use client";

export default function ClientActionPage() {
  return (
    <main>
      <h1>Client action</h1>
      <form action="/_ferrite/action" method="post">
        <input type="hidden" name="__ferrite_action" value="app/client-action/page.tsx#saveClient" />
        <input type="hidden" name="__ferrite_route" value="/client-action" />
        <input name="title" value="Client title" />
        <button type="submit">Save</button>
      </form>
    </main>
  );
}
`,
  );
  await writeFile(
    join(project, "app/island-action/ActionIsland.tsx"),
    `"use client";

export default function ActionIsland() {
  return (
    <form action="/_ferrite/action" method="post">
      <input type="hidden" name="__ferrite_action" value="app/island-action/ActionIsland.tsx#saveIsland" />
      <input type="hidden" name="__ferrite_route" value="/island-action" />
      <input name="title" value="Island title" />
      <button type="submit">Save</button>
    </form>
  );
}
`,
  );
  await writeFile(
    join(project, "app/island-action/page.tsx"),
    `import ActionIsland from "./ActionIsland";

export default function IslandActionPage() {
  return (
    <main>
      <h1>Island action</h1>
      <ActionIsland />
    </main>
  );
}
`,
  );
  await writeFile(
    join(project, "app/server-action/page.tsx"),
    `import { createServerAction } from "@ferrite/runtime/server";

export default function ServerActionPage() {
  const saveServer = createServerAction({
    id: "app/server-action/page.tsx#saveServer",
    routePattern: "/server-action",
    async run({ form }) {
      "use server";
      return { title: form.title };
    },
  });

  return (
    <main>
      <h1>Server-only action</h1>
      <form action={saveServer}>
        <input name="title" value="Server title" />
        <button type="submit">Save</button>
      </form>
    </main>
  );
}
`,
  );
  return project;
}

async function serveBuild(buildDir) {
  const receivedActions = createAsyncQueue();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/_ferrite/action" && request.method === "POST") {
        const body = await readBody(request);
        receivedActions.push({
          path: request.url,
          method: request.method,
          fields: fieldsFromBody(body, request.headers["content-type"] ?? ""),
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ferrite: "server-action-response", version: 1, status: "ok", data: { saved: true } }));
        return;
      }

      const file = resolveStaticFile(buildDir, request.url ?? "/");
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
  return { server, origin: `http://127.0.0.1:${address.port}`, receivedActions };
}

function resolveStaticFile(buildDir, url) {
  const pathname = new URL(url, "http://localhost").pathname;
  const relativePath = pathname.replace(/^\/+/, "");
  const candidates =
    relativePath === ""
      ? [join(buildDir, "index.html")]
      : [join(buildDir, relativePath), join(buildDir, relativePath, "index.html")];
  return candidates.find((candidate) => isFile(candidate) && !relativePath.includes(".."));
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
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fieldsFromBody(body, contentType) {
  if (contentType.startsWith("multipart/form-data")) {
    return fieldsFromMultipartBody(body, contentType);
  }

  const fields = {};
  const params = new URLSearchParams(body);
  for (const [name, value] of params) {
    fields[name] ??= [];
    fields[name].push(value);
  }
  return fields;
}

function fieldsFromMultipartBody(body, contentType) {
  const boundary = contentType.match(/\bboundary=([^;]+)/)?.[1];
  assert.ok(boundary, "multipart action request includes a boundary");
  const fields = {};
  for (const part of body.split(`--${boundary}`)) {
    if (!part.includes("Content-Disposition")) {
      continue;
    }
    const [rawHeaders, rawValue = ""] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    const name = rawHeaders.match(/\bname="([^"]+)"/)?.[1];
    if (!name) {
      continue;
    }
    fields[name] ??= [];
    fields[name].push(rawValue.replace(/\r\n$/, ""));
  }
  return fields;
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
      } else {
        values.push(value);
      }
    },
    next({ timeoutMs, label }) {
      const value = values.shift();
      if (value) {
        return Promise.resolve(value);
      }
      return new Promise((resolveNext, rejectNext) => {
        const waiter = (nextValue) => {
          clearTimeout(timeout);
          resolveNext(nextValue);
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          rejectNext(new Error(`Timed out waiting for enhanced server action request from ${label}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function run(command, args, options) {
  await runCapture(command, args, options);
}

async function runCapture(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const terminalPromise = captureChildTerminal(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const terminal = await terminalPromise;
  if (terminal.error) {
    throw new Error(`${command} ${args.join(" ")} failed to start: ${terminal.error.message}`);
  }
  if (terminal.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${terminal.signal ? `signal ${terminal.signal}` : `exit code ${terminal.code}`}\n${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`,
    );
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function captureChildTerminal(child) {
  return new Promise((resolveTerminal) => {
    let error = null;
    let exitCode = child.exitCode;
    let signalCode = child.signalCode;
    const onError = (nextError) => {
      error = nextError;
    };
    const onExit = (code, signal) => {
      exitCode = code;
      signalCode = signal;
    };
    const onClose = (code, signal) => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      resolveTerminal({
        code: exitCode ?? code,
        signal: signalCode ?? signal,
        error,
      });
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

async function closeOwnedBrowserAndServer(browser, server, serverTerminal, logs) {
  const errors = [];
  try {
    await browser?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await stopChild(server, serverTerminal, logs);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Ferrite browser and server cleanup failed");
  }
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

function captureChildOutput(child) {
  const logs = { stdout: "", stderr: "" };
  const append = (name, chunk) => {
    logs[name] = `${logs[name]}${chunk.toString("utf8")}`.slice(-256 * 1024);
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  return logs;
}

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Ferrite production server exited before readiness\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    try {
      const response = await fetch(`${origin}/posts/alpha`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The bounded readiness loop reports captured server output on timeout.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Ferrite production server did not become ready\n${logs.stdout}\n${logs.stderr}`);
}

async function stopChild(child, terminalPromise, logs) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }

  let terminal = await waitForChildTerminal(terminalPromise, 10_000);
  if (!terminal) {
    child.kill("SIGKILL");
    terminal = await waitForChildTerminal(terminalPromise, 5_000);
    if (!terminal) {
      throw new Error(`Ferrite production server remained alive after SIGKILL\n${logs.stdout}\n${logs.stderr}`);
    }
    throw new Error(`Ferrite production server did not stop after SIGTERM\n${logs.stdout}\n${logs.stderr}`);
  }
  if (terminal.error) {
    throw new Error(`Ferrite production server failed to start: ${terminal.error.message}\n${logs.stdout}\n${logs.stderr}`);
  }
  assert.ok(
    isExpectedChildShutdown(terminal),
    `Ferrite production server exited by ${terminal.signal ?? terminal.code}\n${logs.stdout}\n${logs.stderr}`,
  );
}

function isExpectedChildShutdown(terminal, platform = process.platform) {
  return terminal.code === 0 || (platform === "win32" && terminal.signal === "SIGTERM");
}

async function waitForChildTerminal(terminalPromise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      terminalPromise,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonLogEntries(log) {
  return log.split(/\r?\n/).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry === "object" ? [entry] : [];
    } catch {
      return [];
    }
  });
}
