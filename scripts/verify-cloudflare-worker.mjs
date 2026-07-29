#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = platform === "win32" ? "pnpm.cmd" : "pnpm";
const wrangler = join(
  workspaceRoot,
  "node_modules",
  ".bin",
  platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const renderPage = join(workspaceRoot, "packages/runtime/bin/render-page.mjs");
const compatibilityDate = "2026-07-29";
const commandTimeoutMs = 120_000;

const receipt = await verifyCloudflareWorker();
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

async function verifyCloudflareWorker() {
  await buildPrerequisites();

  const fixtureRoot = await makeFixtureRoot();
  let dev;
  let result;
  let primaryError;
  const cleanupErrors = [];
  try {
    const fixture = await createFixture(fixtureRoot);
    const dryRun = await runCapture(
      wrangler,
      [
        "deploy",
        "--dry-run",
        "--config",
        fixture.config,
        "--outdir",
        fixture.bundle,
        "--metafile",
        join(fixture.bundle, "bundle-meta.json"),
      ],
      { cwd: fixtureRoot, timeoutMs: commandTimeoutMs },
    );
    const bundle = await inventoryFiles(fixture.bundle);
    assert.ok(bundle.files.length > 0, "Wrangler dry-run must emit a Worker bundle.");
    assert.ok(
      bundle.gzipBytes < 3 * 1024 * 1024,
      `The proof Worker exceeds the 3 MiB compressed free-plan limit (${bundle.gzipBytes} bytes).`,
    );

    const port = await reserveLoopbackPort();
    const inspectorPort = await reserveLoopbackPort();
    dev = launchDev(fixture.config, fixture.persist, port, inspectorPort);
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin, dev);

    const scenarios = await verifyScenarios(origin);
    const wasm = await fileIdentity(
      join(workspaceRoot, "packages/protocol-wasm/dist/ferrite_protocol_wasm.wasm"),
    );
    const versions = await toolVersions();

    result = {
      status: "passed",
      runtime: "wrangler dev --local (workerd)",
      compatibilityDate,
      sourceBuildId: fixture.sourceBuildId,
      assetBuildId: fixture.assetBuildId,
      versions,
      wasm,
      bundle: {
        files: bundle.files,
        bytes: bundle.bytes,
        gzipBytes: bundle.gzipBytes,
        dryRunSummary: boundedLog(`${dryRun.stdout}\n${dryRun.stderr}`),
      },
      scenarios,
      cleanup: {
        childStopped: true,
        fixtureRemoved: true,
      },
      limitations: [
        "local workerd proof only; no Cloudflare deployment or traffic",
        "static exact routes only",
        "buffered HTML only; no progressive streaming",
        "deadlines select a response but cannot forcibly cancel non-cooperative component work",
      ],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (dev) {
      try {
        await stopChild(dev);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Cloudflare Worker proof and cleanup failed.",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Cloudflare Worker proof cleanup failed.");
  }
  assert.ok(result, "Cloudflare Worker proof completed without a result.");
  return result;
}

async function buildPrerequisites() {
  await runCapture(
    pnpm,
    ["--filter", "@ferrite/runtime", "build"],
    { cwd: workspaceRoot, timeoutMs: commandTimeoutMs },
  );
  await runCapture(
    pnpm,
    ["--filter", "@ferrite/protocol-wasm", "build"],
    {
      cwd: workspaceRoot,
      env: { ...process.env, PROFILE: "release" },
      timeoutMs: commandTimeoutMs,
    },
  );
}

async function makeFixtureRoot() {
  const parent = join(workspaceRoot, ".ferrite");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "cloudflare-workerd-proof-"));
}

async function createFixture(root) {
  const app = join(root, "app");
  const assets = join(root, "assets");
  const generated = join(root, "generated");
  const bundle = join(root, "bundle");
  const persist = join(root, "persist");
  await Promise.all([
    mkdir(app, { recursive: true }),
    mkdir(assets, { recursive: true }),
    mkdir(generated, { recursive: true }),
  ]);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const scope = join(root, "node_modules/@ferrite");
  await mkdir(scope, { recursive: true });
  await symlink(
    join(workspaceRoot, "packages/runtime"),
    join(scope, "runtime"),
    platform === "win32" ? "junction" : "dir",
  );

  const document = join(app, "document.tsx");
  const documentSource = [
    "export default function Document({ children, head }) {",
    "  return <html><head>{head}</head><body>{children}</body></html>;",
    "}",
    "",
  ].join("\n");
  await writeFile(document, documentSource);

  const pages = [
    {
      name: "docs",
      path: "/docs",
      fallback: "docs/index.html",
      fallbackBody: "<!doctype html><p>docs static fallback</p>",
      source: [
        "let requestRenderCount = 0;",
        'export const metadata = { title: "Ferrite workerd proof" };',
        "export default function Page() {",
        "  requestRenderCount += 1;",
        '  return <main data-runtime="workerd" data-render={requestRenderCount}>Ferrite Worker SSR & fetch</main>;',
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "failure",
      path: "/failure",
      fallback: "failure/index.html",
      fallbackBody: "<!doctype html><p>failure static fallback</p>",
      source: [
        "export default function Page() {",
        '  throw new Error("private fixture render failure");',
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "slow",
      path: "/slow",
      fallback: "slow/index.html",
      fallbackBody: "<!doctype html><p>slow static fallback</p>",
      source: [
        "export default async function Page() {",
        "  await new Promise((resolve) => setTimeout(resolve, 200));",
        "  return <main>late render</main>;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "action",
      path: "/action",
      fallback: "action/index.html",
      fallbackBody: "<!doctype html><p>action static fallback</p>",
      source: [
        "export default function Page() {",
        '  return <form action="/_ferrite/action"><input type="hidden" name="__ferrite_action" value="fixture" /></form>;',
        "}",
        "",
      ].join("\n"),
    },
  ];

  for (const page of pages) {
    page.file = join(app, page.name, "page.tsx");
    page.artifact = join(generated, `${page.name}.mjs`);
    await mkdir(dirname(page.file), { recursive: true });
    await writeFile(page.file, page.source);
    await mkdir(join(assets, dirname(page.fallback)), { recursive: true });
    await writeFile(join(assets, page.fallback), page.fallbackBody);
  }
  await writeFile(join(assets, "asset.txt"), "Ferrite static asset\n");

  const sourceBuildId = digestIdentity(
    {
      document: documentSource,
      pages: pages.map(({ path, source }) => ({ path, source })),
    },
  );
  const assetBuildId = digestIdentity(
    pages.map(({ path, fallback, fallbackBody }) => ({
      path,
      fallback,
      fallbackBody,
    })),
  );
  const manifest = {
    format: { name: "ferrite-server", major: 1, minor: 0 },
    buildId: assetBuildId,
    routes: pages.map(({ path, fallback }) => ({
      path,
      prerendered: { [path]: fallback },
      observedActions: [],
    })),
  };
  await writeFile(
    join(assets, "ferrite-server.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const page of pages) {
    await runCapture(
      process.execPath,
      [
        renderPage,
        "--build-cloudflare-artifact",
        page.file,
        page.artifact,
        "[]",
        JSON.stringify(document),
        "{}",
        page.path,
        JSON.stringify({
          sourceBuildId,
          assetBuildId,
          fallbackPath: `/${page.fallback}`,
          observedActions: [],
        }),
      ],
      { cwd: root, timeoutMs: commandTimeoutMs },
    );
  }

  await Promise.all([
    copyFile(
      join(workspaceRoot, "packages/runtime/dist/cloudflare.js"),
      join(root, "cloudflare.js"),
    ),
    copyFile(
      join(workspaceRoot, "packages/protocol-wasm/dist/index.js"),
      join(root, "protocol-wasm.js"),
    ),
    copyFile(
      join(workspaceRoot, "packages/protocol-wasm/dist/ferrite_protocol_wasm.wasm"),
      join(root, "ferrite_protocol_wasm.wasm"),
    ),
  ]);
  await writeFile(
    join(root, "worker.mjs"),
    [
      'import * as docs from "./generated/docs.mjs";',
      'import * as failure from "./generated/failure.mjs";',
      'import * as slow from "./generated/slow.mjs";',
      'import * as action from "./generated/action.mjs";',
      'import ferriteWasm from "./ferrite_protocol_wasm.wasm";',
      'import { instantiateFerriteProtocolWasm } from "./protocol-wasm.js";',
      'import { createCloudflareSsrHandler } from "./cloudflare.js";',
      "",
      "const renderer = await instantiateFerriteProtocolWasm(ferriteWasm);",
      "export default createCloudflareSsrHandler({",
      "  routes: [docs, failure, slow, action].map((module) => ({",
      "    module,",
      '    document: { rootId: "ferrite-root" },',
      "  })),",
      "  renderer,",
      "  responseDeadlineMs: 50,",
      "  maxPacketBytes: 256 * 1024,",
      "  maxHtmlBytes: 512 * 1024,",
      "  shouldRender(_request, env) {",
      '    return env.FERRITE_SSR_ROLLBACK !== "1";',
      "  },",
      "});",
      "",
    ].join("\n"),
  );

  const config = join(root, "wrangler.jsonc");
  await writeFile(
    config,
    `${JSON.stringify({
      $schema: join(workspaceRoot, "node_modules/wrangler/config-schema.json"),
      name: "ferrite-cloudflare-request-ssr-proof",
      main: "./worker.mjs",
      compatibility_date: compatibilityDate,
      compatibility_flags: ["nodejs_compat"],
      vars: { FERRITE_SSR_ROLLBACK: "0" },
      assets: {
        directory: "./assets",
        binding: "ASSETS",
        run_worker_first: true,
      },
    }, null, 2)}\n`,
  );
  return {
    assetBuildId,
    bundle,
    config,
    persist,
    sourceBuildId,
  };
}

function launchDev(config, persist, port, inspectorPort) {
  const child = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      persist,
      "--log-level",
      "error",
    ],
    {
      cwd: dirname(config),
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.logs = captureChildOutput(child);
  child.terminal = captureChildTerminal(child);
  return child;
}

async function verifyScenarios(origin) {
  const first = await fetchChecked(`${origin}/docs`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-ferrite-render"), "request");
  const firstBody = await first.text();
  assert.match(firstBody, /data-runtime="workerd"/);
  assert.match(firstBody, /data-render="1"/);
  assert.match(firstBody, /Ferrite Worker SSR &amp; fetch/);

  const deepRefresh = await fetchChecked(`${origin}/docs/`);
  assert.equal(deepRefresh.status, 200);
  assert.equal(deepRefresh.headers.get("x-ferrite-render"), "request");
  assert.match(await deepRefresh.text(), /data-render="2"/);

  const head = await fetchChecked(`${origin}/docs`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("x-ferrite-render"), "request");
  assert.equal(await head.text(), "");

  const asset = await fetchChecked(`${origin}/asset.txt`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "Ferrite static asset\n");

  const failure = await fetchChecked(`${origin}/failure`);
  await assertFallback(failure, "failure static fallback");
  const slow = await fetchChecked(`${origin}/slow`);
  await assertFallback(slow, "slow static fallback");
  const action = await fetchChecked(`${origin}/action`);
  await assertFallback(action, "action static fallback");

  const method = await fetchChecked(`${origin}/docs`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
  const representation = await fetchChecked(`${origin}/docs`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(representation.status, 406);
  const payload = await fetchChecked(`${origin}/docs?__ferrite_payload=1`);
  assert.equal(payload.status, 501);
  const traversal = await fetchChecked(`${origin}/%252e%252e/docs`);
  assert.equal(traversal.status, 400);
  const encodedSeparator = await fetchChecked(`${origin}/docs%2Fprivate`);
  assert.equal(encodedSeparator.status, 400);
  const missing = await fetchChecked(`${origin}/missing.txt`);
  assert.equal(missing.status, 404);

  return {
    requestTimeRender: "passed (two isolate-state-distinct renders)",
    deepRouteRefresh: "passed",
    head: "passed",
    staticAssetPassthrough: "passed",
    routeExceptionFallback: "passed",
    responseDeadlineFallback: "passed",
    renderedServerActionFallback: "passed",
    unsupportedMethod: "passed",
    unsupportedRepresentation: "passed",
    payloadStreamRejection: "passed",
    encodedTraversalRejection: "passed",
    encodedSeparatorRejection: "passed",
    missingAsset: "passed",
  };
}

async function assertFallback(response, expectedText) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ferrite-render"), "static-fallback");
  assert.match(await response.text(), new RegExp(expectedText));
}

async function waitForServer(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Wrangler exited before readiness.\n${child.logs.stdout}\n${child.logs.stderr}`,
      );
    }
    try {
      const response = await fetch(`${origin}/asset.txt`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The bounded readiness loop reports captured output on timeout.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `Wrangler did not become ready within 20 seconds.\n${child.logs.stdout}\n${child.logs.stderr}`,
  );
}

async function fetchChecked(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

async function toolVersions() {
  const [wranglerVersion, workerdVersion] = await Promise.all([
    runCapture(wrangler, ["--version"], { cwd: workspaceRoot, timeoutMs: 10_000 }),
    runCapture(
      process.execPath,
      [
        join(
          workspaceRoot,
          "node_modules/.pnpm/workerd@1.20260722.1/node_modules/workerd/bin/workerd",
        ),
        "--version",
      ],
      { cwd: workspaceRoot, timeoutMs: 10_000 },
    ),
  ]);
  return {
    wrangler: wranglerVersion.stdout.trim(),
    workerd: workerdVersion.stdout.trim(),
  };
}

async function inventoryFiles(root) {
  const files = [];
  let bytes = 0;
  let gzipBytes = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const contents = await readFile(path);
      const relative = path.slice(root.length + 1);
      bytes += contents.byteLength;
      gzipBytes += gzipSync(contents).byteLength;
      files.push({
        path: relative,
        bytes: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  await visit(root);
  return { files, bytes, gzipBytes };
}

async function fileIdentity(path) {
  const contents = await readFile(path);
  return {
    bytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function digestIdentity(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function runCapture(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureChildOutput(child);
  const terminal = captureChildTerminal(child);
  let timeout;
  try {
    const result = await Promise.race([
      terminal,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(
          () => resolveTimeout({ timeout: true }),
          options.timeoutMs,
        );
      }),
    ]);
    if (result?.timeout) {
      child.kill("SIGTERM");
      let stopped = await waitForTerminal(terminal, 5_000);
      if (!stopped) {
        child.kill("SIGKILL");
        stopped = await waitForTerminal(terminal, 5_000);
      }
      if (!stopped) {
        throw new Error(
          `${command} ${args.join(" ")} remained alive after SIGKILL.\n${logs.stdout}\n${logs.stderr}`,
        );
      }
      throw new Error(
        `${command} ${args.join(" ")} exceeded ${options.timeoutMs}ms.\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    if (result.error) {
      throw new Error(
        `${command} ${args.join(" ")} failed to start: ${result.error.message}`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}.\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    return logs;
  } finally {
    clearTimeout(timeout);
  }
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

function captureChildTerminal(child) {
  return new Promise((resolveTerminal) => {
    let error;
    child.once("error", (nextError) => {
      error = nextError;
    });
    child.once("close", (code, signal) => {
      resolveTerminal({ code, signal, error });
    });
  });
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  let terminal = await waitForTerminal(child.terminal, 10_000);
  if (!terminal) {
    child.kill("SIGKILL");
    terminal = await waitForTerminal(child.terminal, 5_000);
    if (!terminal) {
      throw new Error(
        `Wrangler remained alive after SIGKILL.\n${child.logs.stdout}\n${child.logs.stderr}`,
      );
    }
    throw new Error(
      `Wrangler did not stop after SIGTERM.\n${child.logs.stdout}\n${child.logs.stderr}`,
    );
  }
  if (terminal.error) {
    throw new Error(
      `Wrangler failed to start: ${terminal.error.message}\n${child.logs.stdout}\n${child.logs.stderr}`,
    );
  }
  if (terminal.code !== 0 && terminal.signal !== "SIGTERM") {
    throw new Error(
      `Wrangler exited by ${terminal.signal ?? terminal.code}.\n${child.logs.stdout}\n${child.logs.stderr}`,
    );
  }
}

async function waitForTerminal(terminal, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      terminal,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function boundedLog(value) {
  return value.trim().slice(-4_096);
}
