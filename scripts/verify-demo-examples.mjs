import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repoRoot, "target", "debug", "ferrite");
const renderer = join(repoRoot, "packages", "runtime", "bin", "render-artifact.mjs");
const browserExecutableCandidates = [
  process.env.FERRITE_BROWSER_EXECUTABLE,
  chromium.executablePath(),
  ...(process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : []),
  ...(process.platform === "win32"
    ? [
        process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : null,
        process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : null,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
        process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : null,
      ]
    : []),
  ...(process.platform === "linux"
    ? [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ]
    : []),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
const browserExecutable = browserExecutableCandidates.find((candidate) => existsSync(candidate));
const examples = [
  {
    name: "hello-world-demo",
    root: join(repoRoot, "examples", "hello-world-demo"),
    paths: ["/"],
    routes: ["/"],
  },
  {
    name: "docs-workbench",
    root: join(repoRoot, "examples", "docs-workbench"),
    paths: ["/", "/guides/getting-started", "/reference/runtime"],
    routes: ["/", "/guides/*slug", "/reference/:id"],
  },
];
const maxOutput = 256 * 1024;
const children = new Set();

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const tail = (value, chunk) => `${value}${chunk.toString("utf8")}`.slice(-maxOutput);

function startTrackedProcess(file, args, options = {}) {
  const child = spawn(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let tracked;
  const closed = new Promise((resolveClosed, rejectClosed) => {
    child.stdout.on("data", (chunk) => { stdout = tail(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (tracked) children.delete(tracked);
      rejectClosed(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (tracked) children.delete(tracked);
      resolveClosed({ code, signal, stdout, stderr });
    });
  });
  tracked = {
    child,
    closed,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
  children.add(tracked);
  return tracked;
}

async function stopProcess(process, label) {
  if (!process) return null;
  if (process.child.exitCode !== null || process.child.signalCode !== null) return process.closed;
  const closed = process.closed.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );
  const waitForClose = async () => {
    let timeout;
    try {
      return await Promise.race([
        closed,
        new Promise((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(null), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  process.child.kill("SIGTERM");
  let outcome = await waitForClose();
  if (!outcome && process.child.exitCode === null && process.child.signalCode === null) {
    process.child.kill("SIGKILL");
    outcome = await waitForClose();
  }
  if (!outcome) throw new Error(`${label} did not exit after SIGKILL`);
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

async function command(file, args, options = {}) {
  const process = startTrackedProcess(file, args, options);
  if (!options.timeoutMs) return { ...(await process.closed), timedOut: false };
  let timeout;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), options.timeoutMs);
  });
  let outcome;
  try {
    outcome = await Promise.race([
      process.closed.then(
        (result) => ({ kind: "exit", result }),
        (error) => ({ kind: "error", error }),
      ),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (outcome.kind === "error") throw outcome.error;
  if (outcome.kind === "exit") return { ...outcome.result, timedOut: false };
  const result = await stopProcess(process, `${file} command`);
  return { ...result, timedOut: true };
}

const assertSuccess = (result, label) => {
  assert.equal(result.timedOut, false, `${label} timed out\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.code, 0, `${label} failed (exit ${result.code ?? result.signal})\n${result.stdout}\n${result.stderr}`);
  return result;
};

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => server.once("error", rejectListen).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  assert.ok(port > 0);
  return port;
}

async function waitForServer(process, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`server exited before listening: ${process.stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(750) });
      return response;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`server did not listen on ${port}`);
}

function startServer(example, artifact, port) {
  return startTrackedProcess(cli, [
    "serve",
    "--project", example.root,
    "--artifact", artifact,
    "--page-renderer", renderer,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--no-color",
  ]);
}

async function stopServer(server) {
  await stopProcess(server, "Ferrite demo server");
}

function sleepUntil(milliseconds, signal) {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep(false);
      return;
    }
    let timer;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolveSleep(false);
    };
    timer = setTimeout(() => {
      cleanup();
      resolveSleep(true);
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function canConnect(port, signal) {
  return new Promise((resolveConnect) => {
    if (signal.aborted) {
      resolveConnect(false);
      return;
    }
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolveConnect(connected);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(150);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForPortBind(port, signal) {
  while (!signal.aborted) {
    if (await canConnect(port, signal)) return true;
    if (!(await sleepUntil(25, signal))) break;
  }
  return false;
}

async function observeExitBeforeBind(process, port, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      process.closed.then((result) => ({ kind: "exit", result })),
      waitForPortBind(port, controller.signal).then((bound) => ({ kind: bound ? "bound" : "aborted" })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function verifyManifest(example) {
  const artifact = join(example.root, ".ferrite", "build");
  const serverManifest = JSON.parse(await readFile(join(artifact, "ferrite-server.json"), "utf8"));
  assert.match(serverManifest.buildId, /^sha256:[a-f0-9]{64}$/);
  assert.ok(serverManifest.files.length > 0, `${example.name} manifest has no files`);
  for (const file of serverManifest.files) {
    const path = join(artifact, file.path);
    const bytes = await readFile(path);
    assert.equal(bytes.byteLength, file.size, `${example.name} size mismatch for ${file.path}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${example.name} hash mismatch for ${file.path}`);
  }
  const routes = serverManifest.routes.map((route) => route.path);
  assert.deepEqual(routes, example.routes, `${example.name} manifest route table`);
  return {
    artifact,
    buildId: serverManifest.buildId,
    routes,
    files: serverManifest.files.length,
    fileRecords: serverManifest.files,
  };
}

async function buildExample(example) {
  await access(join(example.root, "package.json"));
  await access(join(example.root, "app"));
  assertSuccess(await command("cargo", ["run", "--manifest-path", "Cargo.toml", "-q", "-p", "ferrite-cli", "--", "build", "--project", example.root, "--page-renderer", join(repoRoot, "packages/runtime/bin/render-page.mjs"), "--client-bundler", join(repoRoot, "packages/runtime/bin/build-client.mjs")], { timeoutMs: 120_000 }), `build ${example.name}`);
  return verifyManifest(example);
}

async function prepareWorkspace() {
  assertSuccess(await command("pnpm", ["--filter", "@ferrite/protocol", "build"], { timeoutMs: 120_000 }), "build @ferrite/protocol");
  assertSuccess(await command("pnpm", ["--filter", "@ferrite/protocol-wasm", "build"], { timeoutMs: 120_000 }), "build @ferrite/protocol-wasm");
  assertSuccess(await command("pnpm", ["--filter", "@ferrite/runtime", "build"], { timeoutMs: 120_000 }), "build @ferrite/runtime");
  assertSuccess(await command("cargo", ["build", "-q", "-p", "ferrite-cli"], { timeoutMs: 120_000 }), "build ferrite CLI");
}

async function checkExample(example) {
  assertSuccess(await command("cargo", ["run", "--manifest-path", "Cargo.toml", "-q", "-p", "ferrite-cli", "--", "check", "--project", example.root], { timeoutMs: 120_000 }), `check ${example.name}`);
}

async function verifyHttp(example, manifest) {
  const port = await reservePort();
  const server = startServer(example, manifest.artifact, port);
  try {
    const first = await waitForServer(server, port);
    assert.equal(first.status, 200, `${example.name} root status`);
    const root = await first.text();
    assert.ok(root.includes("Ferrite"), `${example.name} root response lacks product text`);
    const query = await fetch(`http://127.0.0.1:${port}/?proof=query`);
    assert.equal(query.status, 200, `${example.name} query status`);
    for (const path of example.paths.slice(1)) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${example.name} ${path} status`);
      assert.ok((await response.text()).length > 80, `${example.name} ${path} response too small`);
    }
    const missing = await fetch(`http://127.0.0.1:${port}/__ferrite_missing_route__`);
    assert.equal(missing.status, 404, `${example.name} missing route status`);
  } finally {
    await stopServer(server);
  }
}

async function verifyTamper(example, manifest) {
  const scratch = await mkdtemp(join(tmpdir(), "ferrite-demo-tamper-"));
  const tampered = join(scratch, "build");
  try {
    await cp(manifest.artifact, tampered, { recursive: true });
    const relative = manifest.fileRecords.find((file) => file.path === "index.html")?.path ?? "ferrite-server.json";
    const targetPath = join(tampered, relative);
    await writeFile(targetPath, `${await readFile(targetPath, "utf8")}\n<!-- tampered -->\n`);
    const port = await reservePort();
    const process = startTrackedProcess(cli, ["serve", "--project", example.root, "--artifact", tampered, "--page-renderer", renderer, "--host", "127.0.0.1", "--port", String(port), "--no-color"]);
    const outcome = await observeExitBeforeBind(process, port, 12_000);
    if (outcome.kind === "bound") {
      await stopProcess(process, `${example.name} tampered server`);
      assert.fail(`${example.name} tampered artifact bound ${port} before rejection`);
    }
    if (outcome.kind === "timeout") {
      await stopProcess(process, `${example.name} tampered server`);
      assert.fail(`${example.name} tampered artifact was not rejected within 12000ms`);
    }
    assert.equal(outcome.kind, "exit", `${example.name} tamper observation ended unexpectedly`);
    assert.equal(outcome.result.signal, null, `${example.name} tampered artifact exited by signal ${outcome.result.signal}`);
    assert.equal(typeof outcome.result.code, "number", `${example.name} tampered artifact did not return an exit code`);
    assert.notEqual(outcome.result.code, 0, `${example.name} tampered artifact unexpectedly served`);
    assert.match(`${outcome.result.stdout}\n${outcome.result.stderr}`, /integrity|sha256|manifest|mismatch|size/i, `${example.name} tampered artifact failed without integrity evidence`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyBrowser(example, manifest) {
  assert.ok(
    browserExecutable,
    `A Chromium browser is required for demo runtime proof. Set FERRITE_BROWSER_EXECUTABLE or install one of: ${browserExecutableCandidates.join(", ")}`,
  );
  const port = await reservePort();
  const server = startServer(example, manifest.artifact, port);
  let browser;
  let page;
  let proofError;
  try {
    browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    const pageErrors = [];
    const failedRequests = [];
    const badResponses = [];
    page = await browser.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`));
    page.on("response", (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });
    await waitForServer(server, port);
    const origin = `http://127.0.0.1:${port}`;
    const response = await page.goto(origin, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200, `${example.name} browser root status`);
    assert.match(await page.title(), /Ferrite/i, `${example.name} browser title`);
    assert.ok(await page.locator("h1").count() > 0, `${example.name} browser root has no h1`);
    if (example.name === "docs-workbench") {
      assert.deepEqual(pageErrors, [], `${example.name} browser hydration errors before interaction`);
      const menu = page.locator("button.menu-toggle");
      assert.equal(await menu.count(), 1, `${example.name} browser menu control missing`);
      await menu.click();
      assert.equal(await menu.getAttribute("aria-expanded"), "true", `${example.name} menu did not update aria-expanded`);
      assert.equal(await page.locator("nav.nav-open").count(), 1, `${example.name} menu did not open navigation`);
      const deep = await page.goto(`${origin}/guides/getting-started`, { waitUntil: "networkidle" });
      assert.equal(deep?.status(), 200, "docs-workbench browser guide status");
      assert.match(await page.title(), /Getting started/i, "docs-workbench guide metadata");
      const unknown = await page.goto(`${origin}/guides/custom/path`, { waitUntil: "networkidle" });
      assert.equal(unknown?.status(), 200, "docs-workbench unknown guide status");
      assert.match(await page.title(), /custom \/ path/i, "docs-workbench unknown guide metadata");
      assert.match((await page.locator("h1").textContent()) ?? "", /custom \/ path/i, "docs-workbench unknown guide heading");
      const reference = await page.goto(`${origin}/reference/runtime`, { waitUntil: "networkidle" });
      assert.equal(reference?.status(), 200, "docs-workbench browser reference status");
      assert.match(await page.title(), /Runtime facade/i, "docs-workbench reference metadata");
    }
    assert.deepEqual(pageErrors, [], `${example.name} browser page errors`);
    assert.deepEqual(failedRequests, [], `${example.name} browser failed requests`);
    assert.deepEqual(badResponses, [], `${example.name} browser HTTP errors`);
  } catch (error) {
    proofError = error;
  }
  const cleanupErrors = [];
  for (const [label, cleanup] of [
    ["page close", () => page?.close()],
    ["browser close", () => browser?.close()],
    ["server stop", () => stopServer(server)],
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(new Error(`${example.name} ${label} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (proofError && cleanupErrors.length === 0) throw proofError;
  if (proofError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(proofError ? [proofError] : []), ...cleanupErrors],
      `${example.name} browser proof or cleanup failed`,
    );
  }
}

async function main() {
  const mode = (process.argv[2] ?? "run").replace(/^--/, "");
  assert.ok(["run", "check-only", "build-only"].includes(mode), `unknown demo verification mode: ${mode}`);
  await prepareWorkspace();
  const available = [];
  for (const example of examples) {
    try { await access(example.root); } catch { throw new Error(`required demo is missing: ${example.root}`); }
    if (mode !== "check-only") available.push({ example, manifest: await buildExample(example) });
    else {
      await checkExample(example);
      available.push({ example, manifest: null });
    }
  }
  if (mode === "build-only" || mode === "check-only") {
    console.log(JSON.stringify({ ok: true, mode, demos: available }, null, 2));
    return;
  }
  for (const { example, manifest } of available) {
    await verifyHttp(example, manifest);
    await verifyTamper(example, manifest);
    await verifyBrowser(example, manifest);
    const deepRouteCount = example.paths.length - 1;
    console.log(
      `${example.name}: build ${manifest.buildId}; ${manifest.files} verified files; HTTP normal/query/${deepRouteCount} deep/404, browser, and tamper fail-closed passed`,
    );
  }
}

let mainError;
try {
  await main();
} catch (error) {
  mainError = error;
}
const cleanupErrors = [];
for (const process of [...children]) {
  try {
    await stopProcess(process, "owned demo process");
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (mainError && cleanupErrors.length === 0) throw mainError;
if (mainError || cleanupErrors.length > 0) {
  throw new AggregateError(
    [...(mainError ? [mainError] : []), ...cleanupErrors],
    "demo verification or final cleanup failed",
  );
}
