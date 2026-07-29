#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  let processCleanup;
  let fixtureRemoved = false;
  let primaryError;
  const cleanupErrors = [];
  try {
    const fixture = await createFixture(fixtureRoot);
    const bundleMetafile = join(fixture.bundle, "bundle-meta.json");
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
        bundleMetafile,
      ],
      { cwd: fixtureRoot, timeoutMs: commandTimeoutMs },
    );
    const bundle = await inventoryFiles(fixture.bundle);
    const routeBundleBindings = await verifyBundledRouteArtifacts(
      fixture,
      bundleMetafile,
      fixtureRoot,
      bundle,
    );
    const staticAssets = await inventoryFiles(fixture.assets);
    assert.ok(bundle.files.length > 0, "Wrangler dry-run must emit a Worker bundle.");
    assert.ok(
      bundle.gzipBytes < 3 * 1024 * 1024,
      `The proof Worker exceeds the 3 MiB compressed free-plan limit (${bundle.gzipBytes} bytes).`,
    );
    const runtimeConfig = await writeExactBundleConfig(
      fixture,
      bundleMetafile,
      fixtureRoot,
    );

    const port = await reserveLoopbackPort();
    const inspectorPort = await reserveLoopbackPort();
    dev = launchDev(runtimeConfig, fixture.persist, port, inspectorPort);
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin, dev);
    dev.processTree = await observeOwnedProcessTree(dev.pid);

    const scenarios = await verifyScenarios(origin);
    const wasm = await fileIdentity(
      join(workspaceRoot, "packages/protocol-wasm/dist/ferrite_protocol_wasm.wasm"),
    );
    const [versions, source, buildConfig, runtimeConfigIdentity, lockfile] = await Promise.all([
      toolVersions(),
      sourceState(),
      fileIdentity(fixture.config),
      fileIdentity(runtimeConfig),
      fileIdentity(join(workspaceRoot, "pnpm-lock.yaml")),
    ]);

    result = {
      status: "passed",
      runtime: "wrangler dev --local --no-bundle (workerd)",
      compatibilityDate,
      source,
      sourceBuildIds: fixture.routeReceipts.map(({ path, sourceBuildId }) => ({
        path,
        sourceBuildId,
      })),
      assetBuildId: fixture.assetBuildId,
      assetManifestSha256: fixture.assetManifestSha256,
      routeReceipts: fixture.routeReceipts,
      versions,
      toolchainInputs: {
        buildConfig,
        runtimeConfig: runtimeConfigIdentity,
        lockfile,
      },
      wasm,
      staticAssets,
      bundle: {
        files: bundle.files,
        bytes: bundle.bytes,
        gzipBytes: bundle.gzipBytes,
        routeBindings: routeBundleBindings,
        dryRunSummary: boundedLog(`${dryRun.stdout}\n${dryRun.stderr}`),
      },
      scenarios,
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
        processCleanup = await stopChild(dev);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRemoved = !(await pathExists(fixtureRoot));
      if (!fixtureRemoved) {
        throw new Error(`Cloudflare Worker proof fixture still exists at ${fixtureRoot}.`);
      }
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
  assert.ok(processCleanup, "Cloudflare Worker proof did not produce process cleanup evidence.");
  result.cleanup = {
    ...processCleanup,
    fixtureRemoved,
  };
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
    mkdir(bundle, { recursive: true }),
    mkdir(generated, { recursive: true }),
    mkdir(persist, { recursive: true }),
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

  const assetBuildId = digestIdentity(
    {
      staticAsset: "Ferrite static asset\n",
      routes: pages.map(({ path, fallback, fallbackBody }) => ({
        path,
        fallback,
        fallbackBody,
      })),
    },
  );

  const routeReceipts = [];
  const routeArtifacts = [];
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
          assetBuildId,
          fallbackPath: `/${page.fallback}`,
          observedActions: [],
        }),
      ],
      { cwd: root, timeoutMs: commandTimeoutMs },
    );
    const receiptPath = `${page.artifact}.receipt.json`;
    const verified = await runCapture(
      process.execPath,
      [
        renderPage,
        "--verify-cloudflare-artifact-receipt",
        page.artifact,
        receiptPath,
      ],
      { cwd: root, timeoutMs: commandTimeoutMs },
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const receiptIdentity = await fileIdentity(receiptPath);
    const verification = JSON.parse(verified.stdout);
    assert.equal(verification.receipt.sha256, receiptIdentity.sha256);
    routeReceipts.push({
      path: page.path,
      sourceBuildId: receipt.sourceBuildId,
      metadataBuildId: receipt.metadataBuildId,
      moduleBuildId: receipt.moduleBuildId,
      moduleBytes: receipt.module.bytes,
      moduleSha256: receipt.module.sha256,
      receiptBytes: receiptIdentity.bytes,
      receiptSha256: receiptIdentity.sha256,
    });
    routeArtifacts.push({
      path: page.path,
      artifact: page.artifact,
      receipt: receiptPath,
    });
  }

  const manifest = {
    format: { name: "ferrite-server", major: 1, minor: 0 },
    buildId: assetBuildId,
    routes: pages.map(({ path, fallback }) => {
      const receipt = routeReceipts.find((candidate) => candidate.path === path);
      assert.ok(receipt);
      return {
        path,
        prerendered: { [path]: fallback },
        observedActions: [],
        cloudflare: receipt,
      };
    }),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const assetManifestSha256 = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  await writeFile(join(assets, "ferrite-server.json"), manifestBytes);

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
      `  assetManifestSha256: ${JSON.stringify(assetManifestSha256)},`,
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
    assets,
    assetBuildId,
    assetManifestSha256,
    bundle,
    config,
    persist,
    routeArtifacts,
    routeReceipts,
  };
}

async function verifyBundledRouteArtifacts(
  fixture,
  metafilePath,
  fixtureRoot,
  bundle,
) {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const outputInputs = new Map();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [inputPath, input] of Object.entries(output?.inputs ?? {})) {
      const absolute = isAbsolute(inputPath) ? inputPath : resolve(fixtureRoot, inputPath);
      outputInputs.set(
        absolute,
        (outputInputs.get(absolute) ?? 0) + Number(input?.bytesInOutput ?? 0),
      );
    }
  }
  const emittedModuleBytes = Buffer.concat(
    await Promise.all(
      bundle.files
        .filter(({ path }) => /\.(?:m?js)$/.test(path))
        .map(({ path }) => readFile(join(fixture.bundle, path))),
    ),
  );
  assert.ok(
    emittedModuleBytes.byteLength > 0,
    "Wrangler dry-run must emit at least one JavaScript Worker module.",
  );

  const bindings = [];
  for (const routeArtifact of fixture.routeArtifacts) {
    const receiptRecord = fixture.routeReceipts.find(
      ({ path }) => path === routeArtifact.path,
    );
    assert.ok(receiptRecord, `Missing route receipt for ${routeArtifact.path}.`);
    const verified = JSON.parse(
      (
        await runCapture(
          process.execPath,
          [
            renderPage,
            "--verify-cloudflare-artifact-receipt",
            routeArtifact.artifact,
            routeArtifact.receipt,
          ],
          { cwd: fixtureRoot, timeoutMs: commandTimeoutMs },
        )
      ).stdout,
    );
    const [artifact, receipt] = await Promise.all([
      fileIdentity(routeArtifact.artifact),
      fileIdentity(routeArtifact.receipt),
    ]);
    assert.deepEqual(artifact, {
      bytes: receiptRecord.moduleBytes,
      sha256: receiptRecord.moduleSha256,
    });
    assert.deepEqual(receipt, {
      bytes: receiptRecord.receiptBytes,
      sha256: receiptRecord.receiptSha256,
    });
    assert.equal(verified.receipt.sourceBuildId, receiptRecord.sourceBuildId);
    assert.equal(verified.receipt.metadataBuildId, receiptRecord.metadataBuildId);
    assert.equal(verified.receipt.moduleBuildId, receiptRecord.moduleBuildId);
    const bytesInOutput = outputInputs.get(resolve(routeArtifact.artifact)) ?? 0;
    assert.ok(
      bytesInOutput > 0,
      `Wrangler metafile did not bind route artifact ${routeArtifact.path} into its output.`,
    );
    for (const [label, identity] of [
      ["metadata", receiptRecord.metadataBuildId],
      ["module", receiptRecord.moduleBuildId],
    ]) {
      assert.equal(
        allBufferOffsets(emittedModuleBytes, Buffer.from(identity)).length,
        1,
        `Wrangler output must contain exactly one ${label} identity for ${routeArtifact.path}.`,
      );
    }
    bindings.push({
      path: routeArtifact.path,
      artifact: relative(fixtureRoot, routeArtifact.artifact).replaceAll("\\", "/"),
      receipt: relative(fixtureRoot, routeArtifact.receipt).replaceAll("\\", "/"),
      bytesInOutput,
      metadataBuildId: receiptRecord.metadataBuildId,
      moduleBuildId: receiptRecord.moduleBuildId,
    });
  }
  return bindings;
}

async function writeExactBundleConfig(fixture, metafilePath, fixtureRoot) {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const entryOutputs = Object.entries(metafile.outputs ?? {})
    .filter(([, output]) => typeof output?.entryPoint === "string")
    .map(([path]) => isAbsolute(path) ? path : resolve(fixtureRoot, path));
  assert.equal(
    entryOutputs.length,
    1,
    `Wrangler dry-run must emit exactly one entry module; found ${entryOutputs.length}.`,
  );
  const entry = entryOutputs[0];
  const bundleRelative = relative(fixture.bundle, entry);
  assert.ok(
    bundleRelative !== "" &&
      !bundleRelative.startsWith("..") &&
      !isAbsolute(bundleRelative),
    "Wrangler dry-run entry module must be inside the inventoried bundle.",
  );
  const config = join(fixtureRoot, "wrangler-exact-bundle.jsonc");
  await writeFile(
    config,
    `${JSON.stringify({
      $schema: join(workspaceRoot, "node_modules/wrangler/config-schema.json"),
      name: "ferrite-cloudflare-request-ssr-proof",
      main: `./${relative(fixtureRoot, entry).replaceAll("\\", "/")}`,
      no_bundle: true,
      find_additional_modules: true,
      base_dir: `./${relative(fixtureRoot, fixture.bundle).replaceAll("\\", "/")}`,
      rules: [
        { type: "ESModule", globs: ["**/*.js", "**/*.mjs"], fallthrough: true },
        { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
      ],
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
  return config;
}

function launchDev(config, persist, port, inspectorPort) {
  const child = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--no-bundle",
      "--no-latest",
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
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
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
  assert.equal(method.headers.get("x-content-type-options"), "nosniff");
  const representation = await fetchChecked(`${origin}/docs`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(representation.status, 406);
  assert.equal(representation.headers.get("x-content-type-options"), "nosniff");
  const payload = await fetchChecked(`${origin}/docs?__ferrite_payload=1`);
  assert.equal(payload.status, 501);
  assert.equal(payload.headers.get("x-content-type-options"), "nosniff");
  const traversal = await fetchChecked(`${origin}/%252e%252e/docs`);
  assert.equal(traversal.status, 400);
  assert.equal(traversal.headers.get("x-content-type-options"), "nosniff");
  const encodedSeparator = await fetchChecked(`${origin}/docs%2Fprivate`);
  assert.equal(encodedSeparator.status, 400);
  assert.equal(encodedSeparator.headers.get("x-content-type-options"), "nosniff");
  const missing = await fetchChecked(`${origin}/missing.txt`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-content-type-options"), "nosniff");

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

async function sourceState() {
  const [head, tree, branch, status] = await Promise.all([
    runCapture("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      timeoutMs: 10_000,
    }),
    runCapture("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: workspaceRoot,
      timeoutMs: 10_000,
    }),
    runCapture("git", ["branch", "--show-current"], {
      cwd: workspaceRoot,
      timeoutMs: 10_000,
    }),
    runCapture("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: workspaceRoot,
      timeoutMs: 10_000,
    }),
  ]);
  return {
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    branch: branch.stdout.trim() || null,
    clean: status.stdout.trim() === "",
    residue: status.stdout.trim() || null,
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

function allBufferOffsets(buffer, needle) {
  const offsets = [];
  let offset = 0;
  while (offset <= buffer.byteLength - needle.byteLength) {
    const found = buffer.indexOf(needle, offset);
    if (found === -1) {
      break;
    }
    offsets.push(found);
    offset = found + needle.byteLength;
  }
  return offsets;
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

async function observeOwnedProcessTree(rootPid) {
  if (platform !== "darwin") {
    throw new Error(
      `Cloudflare Worker process-tree proof currently supports macOS only; found ${platform}.`,
    );
  }
  const descendants = await descendantProcesses(rootPid);
  const workerdObserved = descendants.some(({ command }) =>
    /(?:^|[/\s])workerd(?:\s|$)/.test(command)
  );
  assert.ok(
    workerdObserved,
    "Wrangler became ready without an observable workerd descendant.",
  );
  return {
    descendants,
    workerdObserved,
  };
}

async function stopChild(child) {
  const known = new Map(
    (child.processTree?.descendants ?? []).map((process) => [process.pid, process]),
  );
  for (const process of await descendantProcesses(child.pid)) {
    known.set(process.pid, process);
  }
  const workerdObserved = [...known.values()].some(({ command }) =>
    /(?:^|[/\s])workerd(?:\s|$)/.test(command)
  );

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  let terminalError;
  let wranglerForced = false;
  let terminal = await waitForTerminal(child.terminal, 10_000);
  if (!terminal) {
    wranglerForced = true;
    child.kill("SIGKILL");
    terminal = await waitForTerminal(child.terminal, 5_000);
    if (!terminal) {
      terminalError = new Error(
        `Wrangler remained alive after SIGKILL.\n${child.logs.stdout}\n${child.logs.stderr}`,
      );
    } else {
      terminalError = new Error(
        `Wrangler did not stop after SIGTERM.\n${child.logs.stdout}\n${child.logs.stderr}`,
      );
    }
  } else if (terminal.error) {
    terminalError = new Error(
      `Wrangler failed to start: ${terminal.error.message}\n${child.logs.stdout}\n${child.logs.stderr}`,
    );
  } else if (terminal.code !== 0 && terminal.signal !== "SIGTERM") {
    terminalError = new Error(
      `Wrangler exited by ${terminal.signal ?? terminal.code}.\n${child.logs.stdout}\n${child.logs.stderr}`,
    );
  }

  let live = await matchingLiveProcesses([...known.values()]);
  if (live.length > 0) {
    signalRecordedProcesses(live, "SIGTERM");
    live = await waitForRecordedProcessesToStop(live, 5_000);
  }
  let forced = false;
  if (live.length > 0) {
    forced = true;
    signalRecordedProcesses(live, "SIGKILL");
    live = await waitForRecordedProcessesToStop(live, 5_000);
  }
  if (live.length > 0) {
    throw new Error(
      `Wrangler/workerd descendants survived cleanup: ${live.map(({ pid }) => pid).join(", ")}.`,
    );
  }
  if (terminalError) {
    throw terminalError;
  }
  return {
    wranglerTerminalObserved: true,
    workerdObserved,
    recordedDescendants: known.size,
    survivingDescendants: 0,
    forcedWranglerKill: wranglerForced,
    forcedDescendantKill: forced,
  };
}

async function descendantProcesses(rootPid) {
  if (platform === "win32") {
    return [];
  }
  const table = await processTable();
  const children = new Map();
  for (const process of table) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  const descendants = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const visited = new Set();
  while (pending.length > 0) {
    const process = pending.shift();
    if (!process || visited.has(process.pid)) {
      continue;
    }
    visited.add(process.pid);
    descendants.push(process);
    pending.push(...(children.get(process.pid) ?? []));
  }
  return descendants;
}

async function processTable() {
  const { stdout } = await runCapture(
    "ps",
    ["-axo", "pid=,ppid=,command="],
    { cwd: workspaceRoot, timeoutMs: 10_000 },
  );
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }));
}

async function matchingLiveProcesses(recorded) {
  if (recorded.length === 0) {
    return [];
  }
  const liveByPid = new Map(
    (await processTable()).map((process) => [process.pid, process]),
  );
  return recorded.filter((process) =>
    liveByPid.get(process.pid)?.command === process.command
  );
}

function signalRecordedProcesses(processes, signal) {
  for (const record of processes.sort((left, right) => right.pid - left.pid)) {
    try {
      process.kill(record.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

async function waitForRecordedProcessesToStop(recorded, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let live = await matchingLiveProcesses(recorded);
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    live = await matchingLiveProcesses(recorded);
  }
  return live;
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
