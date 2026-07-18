import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repoRoot, "target", "debug", "ferrite");
const renderer = join(repoRoot, "packages", "runtime", "bin", "render-artifact.mjs");
const chromeExecutable = process.env.FERRITE_BROWSER_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

const tail = (value, chunk) => `${value}${chunk.toString("utf8")}`.slice(-maxOutput);
const command = (file, args, options = {}) => new Promise((resolveCommand, rejectCommand) => {
  const child = spawn(file, args, { cwd: options.cwd ?? repoRoot, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let settled = false;
  let killTimer = null;
  const timer = options.timeoutMs ? setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, options.timeoutMs) : null;
  child.stdout.on("data", (chunk) => { stdout = tail(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk); });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    children.delete(child);
    rejectCommand(error);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    children.delete(child);
    resolveCommand({ code, signal, stdout, stderr });
  });
});

const assertSuccess = (result, label) => {
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

async function waitForServer(child, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null) throw new Error(`server exited before listening: ${child.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(750) });
      return response;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`server did not listen on ${port}`);
}

function startServer(example, artifact, port) {
  const child = spawn(cli, ["serve", "--project", example.root, "--artifact", artifact, "--page-renderer", renderer, "--host", "127.0.0.1", "--port", String(port), "--no-color"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk); });
  child.stdout.on("data", () => {});
  child.once("close", () => { children.delete(child); });
  return { child, get stderr() { return stderr; } };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const closed = new Promise((resolveClose) => server.child.once("close", resolveClose));
  server.child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!stopped && server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    const killed = await Promise.race([
      closed.then(() => true),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
    ]);
    assert.equal(killed, true, "Ferrite demo server did not exit after SIGKILL");
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
    const result = await command(cli, ["serve", "--project", example.root, "--artifact", tampered, "--page-renderer", renderer, "--host", "127.0.0.1", "--port", String(port), "--no-color"], { timeoutMs: 12_000 });
    assert.notEqual(result.code, 0, `${example.name} tampered artifact unexpectedly served`);
    assert.match(`${result.stdout}\n${result.stderr}`, /integrity|sha256|manifest|mismatch|size/i, `${example.name} tampered artifact failed without integrity evidence`);
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }),
      `${example.name} tampered artifact bound a server port before failing`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyBrowser(example, manifest) {
  if (!existsSync(chromeExecutable)) {
    if (process.env.FERRITE_ALLOW_BROWSER_SKIP === "1") {
      console.log(`${example.name}: browser proof explicitly skipped (Chrome not found at ${chromeExecutable})`);
      return;
    }
    throw new Error(
      `Chrome is required for demo runtime proof at ${chromeExecutable}; set FERRITE_ALLOW_BROWSER_SKIP=1 only when recording the proof gap`,
    );
  }
  const port = await reservePort();
  const server = startServer(example, manifest.artifact, port);
  let browser;
  let page;
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
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
      assert.notEqual(await menu.getAttribute("aria-expanded"), null, `${example.name} menu did not update aria-expanded`);
      assert.equal(await page.locator("nav.nav-open").count(), 1, `${example.name} menu did not open navigation`);
      const deep = await page.goto(`${origin}/guides/getting-started`, { waitUntil: "networkidle" });
      assert.equal(deep?.status(), 200, "docs-workbench browser guide status");
      assert.match(await page.title(), /Getting started/i, "docs-workbench guide metadata");
      const reference = await page.goto(`${origin}/reference/runtime`, { waitUntil: "networkidle" });
      assert.equal(reference?.status(), 200, "docs-workbench browser reference status");
      assert.match(await page.title(), /Runtime facade/i, "docs-workbench reference metadata");
    }
    assert.deepEqual(pageErrors, [], `${example.name} browser page errors`);
    assert.deepEqual(failedRequests, [], `${example.name} browser failed requests`);
    assert.deepEqual(badResponses, [], `${example.name} browser HTTP errors`);
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
    await stopServer(server);
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

try {
  await main();
} finally {
  for (const child of [...children]) child.kill("SIGTERM");
}
