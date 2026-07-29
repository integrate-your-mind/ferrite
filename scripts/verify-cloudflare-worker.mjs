#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
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
const workspaceProofOutputPaths = Object.freeze([
  ".ferrite",
  "packages/protocol-wasm/dist",
  "packages/runtime/dist",
  "target",
]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await verifyCloudflareWorker();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

async function verifyCloudflareWorker() {
  const committedSource = await committedSourceContract();
  const trackedPaths = committedSource.records.map(({ path }) => path);
  const sourceMonitor = await startTrackedSourceMonitor(trackedPaths, workspaceRoot, {
    allowedWritePrefixes: workspaceProofOutputPaths,
    rejectUnexpectedPaths: true,
  });
  let sourceStart;
  try {
    sourceStart = {
      ...await sourceState(),
      ...await trackedSourceSnapshot(committedSource),
    };
    assertCleanSourceState(sourceStart, "before the proof");
    await sourceMonitor.assertUnchanged();
  } catch (error) {
    sourceMonitor.close();
    throw error;
  }
  const proofInputSha256 = digestIdentity({
    format: "ferrite-cloudflare-workerd-proof-input",
    version: 1,
    command: ["node", "scripts/verify-cloudflare-worker.mjs"],
    compatibilityDate,
    source: {
      head: sourceStart.head,
      tree: sourceStart.tree,
      branch: sourceStart.branch,
      committedSourceSha256: sourceStart.committedSourceSha256,
      trackedInputSha256: sourceStart.trackedInputSha256,
    },
  });

  let fixtureRoot;
  let fixture;
  let fixtureInputs;
  let fixtureInputMonitor;
  let bundle;
  let bundleMonitor;
  let bundleMetafile;
  let bundleMetafileIdentity;
  let bundleMetafileMonitor;
  let runtimeConfig;
  let runtimeConfigIdentity;
  let runtimeConfigMonitor;
  let dev;
  let result;
  let processCleanup;
  let fixtureRemoved = false;
  let sourceEnd;
  let primaryError;
  const cleanupErrors = [];
  try {
    await buildPrerequisites();
    fixtureRoot = await makeFixtureRoot();
    fixture = await createFixture(fixtureRoot);
    fixtureInputs = await inventoryProofInputs(
      fixtureRoot,
      [fixture.app, fixture.assets, fixture.generated, ...fixture.inputFiles],
    );
    fixtureInputMonitor = await startTrackedSourceMonitor(
      fixtureInputs.files.map(({ path }) => path),
      fixtureRoot,
    );
    await verifyRouteArtifactReceipts(fixture, fixtureRoot);
    assert.deepEqual(
      await inventoryProofInputs(
        fixtureRoot,
        [fixture.app, fixture.assets, fixture.generated, ...fixture.inputFiles],
      ),
      fixtureInputs,
      "Cloudflare fixture inputs changed before Wrangler bundling.",
    );
    await fixtureInputMonitor.assertUnchanged();

    bundleMetafile = join(fixtureRoot, "bundle-meta.json");
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
    bundleMetafileMonitor = await startTrackedSourceMonitor(
      [relative(fixtureRoot, bundleMetafile).replaceAll("\\", "/")],
      fixtureRoot,
    );
    bundleMetafileIdentity = await fileIdentity(bundleMetafile);
    await bundleMetafileMonitor.assertUnchanged();
    assert.deepEqual(
      await inventoryProofInputs(
        fixtureRoot,
        [fixture.app, fixture.assets, fixture.generated, ...fixture.inputFiles],
      ),
      fixtureInputs,
      "Cloudflare fixture inputs changed during Wrangler bundling.",
    );
    await fixtureInputMonitor.assertUnchanged();
    bundle = await inventoryFiles(fixture.bundle);
    bundleMonitor = await startTrackedSourceMonitor(
      bundle.files.map(({ path }) => path),
      fixture.bundle,
    );
    const checkMetafile = join(fixtureRoot, "bundle-check-meta.json");
    await runCapture(
      wrangler,
      [
        "deploy",
        "--dry-run",
        "--config",
        fixture.config,
        "--outdir",
        fixture.bundleCheck,
        "--metafile",
        checkMetafile,
      ],
      { cwd: fixtureRoot, timeoutMs: commandTimeoutMs },
    );
    assert.deepEqual(
      await inventoryFiles(fixture.bundleCheck),
      bundle,
      "Two Wrangler dry-runs from the same verified inputs emitted different Worker bundles.",
    );
    await bundleMonitor.assertUnchanged();
    const routeBundleBindings = await verifyBundledRouteArtifacts(
      fixture,
      bundleMetafile,
      fixtureRoot,
      bundle,
      fixtureInputs,
    );
    const staticAssets = await inventoryFiles(fixture.assets);
    assert.ok(bundle.files.length > 0, "Wrangler dry-run must emit a Worker bundle.");
    assert.ok(
      bundle.gzipBytes < 3 * 1024 * 1024,
      `The proof Worker exceeds the 3 MiB compressed free-plan limit (${bundle.gzipBytes} bytes).`,
    );
    runtimeConfig = await writeExactBundleConfig(
      fixture,
      bundleMetafile,
      fixtureRoot,
      bundle,
    );
    runtimeConfigMonitor = await startTrackedSourceMonitor(
      [relative(fixtureRoot, runtimeConfig).replaceAll("\\", "/")],
      fixtureRoot,
    );
    runtimeConfigIdentity = await fileIdentity(runtimeConfig);
    await runtimeConfigMonitor.assertUnchanged();

    const port = await reserveLoopbackPort();
    const inspectorPort = await reserveLoopbackPort();
    dev = launchDev(runtimeConfig, fixture.persist, port, inspectorPort);
    const origin = `http://127.0.0.1:${port}`;
    await waitForServer(origin, dev);
    dev.processTree = await observeOwnedProcessTree(dev.pid);

    const scenarios = await verifyScenarios(origin);
    const [bundleAfter, staticAssetsAfter, routeBundleBindingsAfter] = await Promise.all([
      inventoryFiles(fixture.bundle),
      inventoryFiles(fixture.assets),
      verifyBundledRouteArtifacts(
        fixture,
        bundleMetafile,
        fixtureRoot,
        bundle,
        fixtureInputs,
      ),
    ]);
    assert.deepEqual(
      bundleAfter,
      bundle,
      "The exact Worker bundle changed while workerd was executing it.",
    );
    assert.deepEqual(
      staticAssetsAfter,
      staticAssets,
      "The static asset snapshot changed while workerd was executing it.",
    );
    assert.deepEqual(
      routeBundleBindingsAfter,
      routeBundleBindings,
      "The route artifact bindings changed while workerd was executing them.",
    );
    assert.deepEqual(
      await inventoryProofInputs(
        fixtureRoot,
        [fixture.app, fixture.assets, fixture.generated, ...fixture.inputFiles],
      ),
      fixtureInputs,
      "Cloudflare fixture inputs changed while workerd was executing the bundle.",
    );
    await fixtureInputMonitor.assertUnchanged();
    await bundleMonitor.assertUnchanged();
    assert.deepEqual(
      await fileIdentity(bundleMetafile),
      bundleMetafileIdentity,
      "The Wrangler metafile changed while its bundle was being verified or executed.",
    );
    await bundleMetafileMonitor.assertUnchanged();
    assert.deepEqual(
      await fileIdentity(runtimeConfig),
      runtimeConfigIdentity,
      "The exact-bundle Wrangler config changed while workerd was executing it.",
    );
    await runtimeConfigMonitor.assertUnchanged();
    const wasm = await fileIdentity(
      join(workspaceRoot, "packages/protocol-wasm/dist/ferrite_protocol_wasm.wasm"),
    );
    const [versions, buildConfig, lockfile] = await Promise.all([
      toolVersions(),
      fileIdentity(fixture.config),
      fileIdentity(join(workspaceRoot, "pnpm-lock.yaml")),
    ]);

    result = {
      status: "passed",
      runtime: "wrangler dev --local --no-bundle (workerd)",
      compatibilityDate,
      source: {
        ...sourceStart,
        proofInputSha256,
      },
      sourceBuildIds: fixture.routeReceipts.map(({ path, sourceBuildId }) => ({
        path,
        sourceBuildId,
      })),
      assetBuildId: fixture.assetBuildId,
      assetManifestSha256: fixture.assetManifestSha256,
      fixtureInputs,
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
        deterministicDryRuns: true,
        stableThroughRuntime: true,
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
    if (fixtureInputMonitor && fixtureInputs && fixture && fixtureRoot) {
      try {
        assert.deepEqual(
          await inventoryProofInputs(
            fixtureRoot,
            [fixture.app, fixture.assets, fixture.generated, ...fixture.inputFiles],
          ),
          fixtureInputs,
          "Cloudflare fixture inputs changed before proof cleanup.",
        );
        await fixtureInputMonitor.assertUnchanged();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        fixtureInputMonitor.close();
      }
    }
    if (bundleMonitor && bundle && fixture) {
      try {
        assert.deepEqual(
          await inventoryFiles(fixture.bundle),
          bundle,
          "The exact Worker bundle changed before proof cleanup.",
        );
        await bundleMonitor.assertUnchanged();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        bundleMonitor.close();
      }
    }
    for (const [monitor, path, identity, message] of [
      [
        bundleMetafileMonitor,
        bundleMetafile,
        bundleMetafileIdentity,
        "The Wrangler metafile changed before proof cleanup.",
      ],
      [
        runtimeConfigMonitor,
        runtimeConfig,
        runtimeConfigIdentity,
        "The exact-bundle Wrangler config changed before proof cleanup.",
      ],
    ]) {
      if (!monitor) {
        continue;
      }
      try {
        if (path && identity) {
          assert.deepEqual(await fileIdentity(path), identity, message);
        }
        await monitor.assertUnchanged();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        monitor.close();
      }
    }
    if (fixtureRoot) {
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
    try {
      const committedSourceEnd = await committedSourceContract();
      sourceEnd = {
        ...await sourceState(),
        ...await trackedSourceSnapshot(committedSourceEnd),
      };
      assertSameSourceState(sourceStart, sourceEnd);
      await sourceMonitor.assertUnchanged();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      sourceMonitor.close();
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
  result.source.end = sourceEnd;
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
  const bundleCheck = join(root, "bundle-check");
  const persist = join(root, "persist");
  await Promise.all([
    mkdir(app, { recursive: true }),
    mkdir(assets, { recursive: true }),
    mkdir(bundle, { recursive: true }),
    mkdir(bundleCheck, { recursive: true }),
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
    app,
    assets,
    assetBuildId,
    assetManifestSha256,
    bundle,
    bundleCheck,
    config,
    generated,
    inputFiles: [
      join(root, "package.json"),
      join(root, "cloudflare.js"),
      join(root, "protocol-wasm.js"),
      join(root, "ferrite_protocol_wasm.wasm"),
      join(root, "worker.mjs"),
      config,
    ],
    persist,
    routeArtifacts,
    routeReceipts,
  };
}

async function verifyRouteArtifactReceipts(fixture, fixtureRoot) {
  const verifiedRoutes = new Map();
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
    verifiedRoutes.set(routeArtifact.path, receiptRecord);
  }
  return verifiedRoutes;
}

async function verifyBundledRouteArtifacts(
  fixture,
  metafilePath,
  fixtureRoot,
  bundle,
  fixtureInputs,
) {
  const verifiedRoutes = await verifyRouteArtifactReceipts(fixture, fixtureRoot);
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const allowedInputs = new Set(
    await Promise.all(
      fixtureInputs.files.map(({ path }) => realpath(join(fixtureRoot, path))),
    ),
  );
  const outputInputs = new Map();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [inputPath, input] of Object.entries(output?.inputs ?? {})) {
      const absolute = isAbsolute(inputPath) ? inputPath : resolve(fixtureRoot, inputPath);
      const canonicalInput = await realpath(absolute);
      assert.ok(
        allowedInputs.has(canonicalInput),
        `Wrangler bundled unmonitored input "${inputPath}".`,
      );
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
  assert.equal(
    allBufferOffsets(
      emittedModuleBytes,
      Buffer.from(fixture.assetManifestSha256),
    ).length,
    1,
    "Wrangler output must contain exactly one pinned asset-manifest identity.",
  );

  const bindings = [];
  for (const routeArtifact of fixture.routeArtifacts) {
    const receiptRecord = verifiedRoutes.get(routeArtifact.path);
    assert.ok(receiptRecord, `Missing route receipt for ${routeArtifact.path}.`);
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

async function writeExactBundleConfig(fixture, metafilePath, fixtureRoot, bundle) {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const entryOutputs = Object.entries(metafile.outputs ?? {})
    .filter(([, output]) => typeof output?.entryPoint === "string")
    .map(([path]) => isAbsolute(path) ? path : resolve(fixtureRoot, path));
  assert.equal(
    entryOutputs.length,
    1,
    `Wrangler dry-run must emit exactly one entry module; found ${entryOutputs.length}.`,
  );
  const entry = await assertInventoriedRegularFile(
    fixture.bundle,
    entryOutputs[0],
    bundle,
    "Wrangler dry-run entry module",
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

export async function assertInventoriedRegularFile(
  root,
  candidate,
  inventory,
  label = "proof file",
) {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  const lexicalRelative = relative(lexicalRoot, lexicalCandidate);
  if (
    lexicalRelative === "" ||
    lexicalRelative.startsWith("..") ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error(`${label} must be inside the inventoried bundle.`);
  }
  const [canonicalRoot, candidateStat] = await Promise.all([
    realpath(lexicalRoot),
    lstat(lexicalCandidate),
  ]);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file.`);
  }
  const canonicalCandidate = await realpath(lexicalCandidate);
  if (canonicalCandidate !== resolve(canonicalRoot, lexicalRelative)) {
    throw new Error(`${label} must not traverse an intermediate symlink.`);
  }
  const candidateRelative = relative(canonicalRoot, canonicalCandidate);
  if (
    candidateRelative === "" ||
    candidateRelative.startsWith("..") ||
    isAbsolute(candidateRelative)
  ) {
    throw new Error(`${label} must resolve inside the inventoried bundle.`);
  }
  const inventoryPath = candidateRelative.replaceAll("\\", "/");
  const record = inventory.files.find(({ path }) => path === inventoryPath);
  if (!record) {
    throw new Error(`${label} is missing from the exact bundle inventory.`);
  }
  assert.deepEqual(
    await fileIdentity(canonicalCandidate),
    { bytes: record.bytes, sha256: record.sha256 },
    `${label} changed after the exact bundle inventory was captured.`,
  );
  return canonicalCandidate;
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
    runCapture("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
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

async function committedSourceContract() {
  const options = {
    cwd: workspaceRoot,
    maxOutputBytes: 8 * 1024 * 1024,
    timeoutMs: 10_000,
  };
  const [formatResult, treeResult, indexResult, flagsResult] = await Promise.all([
    runCapture("git", ["rev-parse", "--show-object-format"], options),
    runCapture("git", ["ls-tree", "-rz", "--full-tree", "HEAD"], options),
    runCapture("git", ["ls-files", "--stage", "-z"], options),
    runCapture("git", ["ls-files", "-v", "-z"], options),
  ]);
  const objectFormat = formatResult.stdout.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`Ferrite proof does not support Git object format "${objectFormat}".`);
  }

  const tree = parseUniqueRecords(
    treeResult.stdout,
    "HEAD tree",
    (record) => {
      const tab = record.indexOf("\t");
      const match = record.slice(0, tab).match(/^(\d+) ([a-z]+) ([a-f0-9]+)$/);
      if (tab < 1 || !match) {
        throw new Error(`Ferrite proof could not parse HEAD tree record "${record}".`);
      }
      return {
        path: record.slice(tab + 1),
        mode: match[1],
        type: match[2],
        oid: match[3],
      };
    },
  );
  const index = parseUniqueRecords(
    indexResult.stdout,
    "Git index",
    (record) => {
      const tab = record.indexOf("\t");
      const match = record.slice(0, tab).match(/^(\d+) ([a-f0-9]+) ([0-3])$/);
      if (tab < 1 || !match) {
        throw new Error(`Ferrite proof could not parse Git index record "${record}".`);
      }
      return {
        path: record.slice(tab + 1),
        mode: match[1],
        oid: match[2],
        stage: Number(match[3]),
      };
    },
  );
  const flags = parseUniqueRecords(
    flagsResult.stdout,
    "Git index flags",
    (record) => {
      const match = record.match(/^(.?) (.*)$/s);
      if (!match) {
        throw new Error(`Ferrite proof could not parse Git index flag record "${record}".`);
      }
      return { path: match[2], tag: match[1] };
    },
  );

  assert.equal(index.size, tree.size, "Ferrite Git index entry count differs from HEAD.");
  assert.equal(flags.size, tree.size, "Ferrite Git index flag count differs from HEAD.");
  const records = [];
  for (const expected of [...tree.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    if (expected.type !== "blob" || !["100644", "100755", "120000"].includes(expected.mode)) {
      throw new Error(
        `Ferrite proof does not support tracked ${expected.type} "${expected.path}" with mode ${expected.mode}.`,
      );
    }
    const indexed = index.get(expected.path);
    assert.deepEqual(
      indexed,
      {
        path: expected.path,
        mode: expected.mode,
        oid: expected.oid,
        stage: 0,
      },
      `Ferrite Git index entry "${expected.path}" differs from HEAD.`,
    );
    assertSupportedIndexFlag(expected.path, flags.get(expected.path)?.tag);
    records.push({
      path: expected.path,
      mode: expected.mode,
      oid: expected.oid,
    });
  }
  return {
    objectFormat,
    records,
    committedSourceSha256: digestIdentity({
      format: "ferrite-committed-source-contract",
      version: 1,
      objectFormat,
      records,
    }),
  };
}

function parseUniqueRecords(stdout, label, parse) {
  const records = new Map();
  for (const raw of stdout.split("\0").filter(Boolean)) {
    const record = parse(raw);
    if (
      !record.path ||
      isAbsolute(record.path) ||
      record.path === ".." ||
      record.path.startsWith("../")
    ) {
      throw new Error(`Ferrite proof received an invalid ${label} path "${record.path}".`);
    }
    if (records.has(record.path)) {
      throw new Error(`Ferrite proof received duplicate ${label} path "${record.path}".`);
    }
    records.set(record.path, record);
  }
  assert.ok(records.size > 0, `Ferrite proof found no ${label} records.`);
  return records;
}

export function assertSupportedIndexFlag(path, tag) {
  assert.equal(
    tag,
    "H",
    `Ferrite tracked input "${path}" has assume-unchanged, skip-worktree, or another unsupported index flag.`,
  );
}

export async function trackedSourceSnapshot(contract, root = workspaceRoot) {
  const records = [];
  for (const expected of contract.records) {
    const absolute = resolve(root, expected.path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: "buffer" });
      assert.equal(
        expected.mode,
        "120000",
        `Ferrite tracked input "${expected.path}" mode differs from HEAD.`,
      );
      assert.equal(
        gitBlobObjectId(target, contract.objectFormat),
        expected.oid,
        `Ferrite tracked input "${expected.path}" bytes differ from HEAD.`,
      );
      records.push({
        path: expected.path,
        mode: expected.mode,
        bytes: target.byteLength,
        sha256: createHash("sha256").update(target).digest("hex"),
      });
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Ferrite tracked input "${expected.path}" is not a regular file or symlink.`,
      );
    }
    const actualMode = stat.mode & 0o111 ? "100755" : "100644";
    assert.equal(
      actualMode,
      expected.mode,
      `Ferrite tracked input "${expected.path}" mode differs from HEAD.`,
    );
    const contents = await readFile(absolute);
    assert.equal(
      gitBlobObjectId(contents, contract.objectFormat),
      expected.oid,
      `Ferrite tracked input "${expected.path}" bytes differ from HEAD.`,
    );
    records.push({
      path: expected.path,
      mode: actualMode,
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return {
    trackedFileCount: records.length,
    committedSourceSha256: contract.committedSourceSha256,
    trackedInputSha256: digestIdentity({
      format: "ferrite-tracked-source-snapshot",
      version: 1,
      records,
    }),
  };
}

export function gitBlobObjectId(bytes, objectFormat) {
  const contents = Buffer.from(bytes);
  return createHash(objectFormat)
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest("hex");
}

export async function startTrackedSourceMonitor(
  paths,
  root = workspaceRoot,
  {
    allowedWritePrefixes = [],
    rejectUnexpectedPaths = false,
  } = {},
) {
  const trackedEntries = new Set(paths);
  const allowedWrites = allowedWritePrefixes.map((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (
      !normalized ||
      isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new TypeError(`Ferrite source monitor received invalid output path "${prefix}".`);
    }
    return normalized;
  });
  const directories = new Set();
  for (const path of paths) {
    directories.add(dirname(path));
  }

  // FSEvents can deliver writes completed immediately before a directory
  // watcher is registered. Establish the monitoring boundary only after those
  // setup writes have settled; callers await this function before consuming
  // any of the protected inputs.
  if (platform === "darwin") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  const changes = [];
  const watchers = [];
  try {
    for (const directory of directories) {
      const absoluteDirectory = resolve(root, directory);
      const watcher = watch(
        absoluteDirectory,
        { persistent: false },
        (eventType, filename) => {
          if (changes.length >= 32) {
            return;
          }
          if (filename === null) {
            changes.push(`${eventType}:<unknown>:${directory}`);
            return;
          }
          const path = relative(
            root,
            resolve(absoluteDirectory, filename.toString()),
          ).replaceAll("\\", "/");
          const allowedWrite = allowedWrites.some(
            (prefix) => path === prefix || path.startsWith(`${prefix}/`),
          );
          if (trackedEntries.has(path) || (rejectUnexpectedPaths && !allowedWrite)) {
            changes.push(`${eventType}:${path}`);
          }
        },
      );
      watcher.on("error", (error) => {
        if (changes.length < 32) {
          changes.push(`watch-error:${directory}:${error.message}`);
        }
      });
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) {
      watcher.close();
    }
    throw error;
  }

  return {
    async assertUnchanged() {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      assert.deepEqual(
        changes,
        [],
        `Ferrite tracked source changed during the Worker proof: ${changes.join(", ")}.`,
      );
    },
    close() {
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

export function assertCleanSourceState(source, context) {
  assert.equal(
    source.clean,
    true,
    `Ferrite Cloudflare Worker proof requires a clean source tree ${context}; found ${source.residue ?? "unknown residue"}.`,
  );
}

export function assertSameSourceState(expected, actual) {
  assertCleanSourceState(actual, "after cleanup");
  assert.deepEqual(
    {
      head: actual.head,
      tree: actual.tree,
      branch: actual.branch,
      committedSourceSha256: actual.committedSourceSha256,
      trackedFileCount: actual.trackedFileCount,
      trackedInputSha256: actual.trackedInputSha256,
    },
    {
      head: expected.head,
      tree: expected.tree,
      branch: expected.branch,
      committedSourceSha256: expected.committedSourceSha256,
      trackedFileCount: expected.trackedFileCount,
      trackedInputSha256: expected.trackedInputSha256,
    },
    "Ferrite source HEAD, tree, branch, or tracked-input identity changed during the Worker proof.",
  );
}

export async function inventoryFiles(root) {
  const canonicalRoot = await realpath(root);
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
        throw new Error(
          `Ferrite proof inventory rejects non-regular entry "${relative(canonicalRoot, path)}".`,
        );
      }
      const contents = await readFile(path);
      const inventoryPath = relative(canonicalRoot, path).replaceAll("\\", "/");
      bytes += contents.byteLength;
      gzipBytes += gzipSync(contents).byteLength;
      files.push({
        path: inventoryPath,
        bytes: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  await visit(canonicalRoot);
  return { files, bytes, gzipBytes };
}

async function inventoryProofInputs(root, locations) {
  const canonicalRoot = await realpath(root);
  const files = [];
  for (const location of locations) {
    const stat = await lstat(location);
    if (stat.isSymbolicLink()) {
      throw new Error(`Ferrite proof input "${location}" must not be a symlink.`);
    }
    if (stat.isDirectory()) {
      const inventory = await inventoryFiles(location);
      const prefix = relative(canonicalRoot, await realpath(location)).replaceAll("\\", "/");
      for (const file of inventory.files) {
        files.push({
          ...file,
          path: `${prefix}/${file.path}`,
        });
      }
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Ferrite proof input "${location}" must be a regular file.`);
    }
    const canonicalLocation = await realpath(location);
    const path = relative(canonicalRoot, canonicalLocation).replaceAll("\\", "/");
    if (path === "" || path.startsWith("..") || isAbsolute(path)) {
      throw new Error(`Ferrite proof input "${location}" must resolve inside its fixture.`);
    }
    files.push({ path, ...await fileIdentity(canonicalLocation) });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set();
  for (const { path } of files) {
    if (seen.has(path)) {
      throw new Error(`Ferrite proof input "${path}" was inventoried more than once.`);
    }
    seen.add(path);
  }
  return {
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    sha256: digestIdentity({
      format: "ferrite-cloudflare-fixture-inputs",
      version: 1,
      files,
    }),
  };
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

export async function runCapture(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureChildOutput(child, options.maxOutputBytes);
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
      await cleanupCapturedProcessTree(child, terminal, true);
      throw new Error(
        `${command} ${args.join(" ")} exceeded ${options.timeoutMs}ms.\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    const cleanup = await cleanupCapturedProcessTree(child, terminal, false);
    if (cleanup.hadDescendants) {
      throw new Error(
        `${command} ${args.join(" ")} left ${cleanup.recordedDescendants} descendant process(es) after it exited; the verifier terminated them.\n${logs.stdout}\n${logs.stderr}`,
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

async function cleanupCapturedProcessTree(child, terminal, terminateRoot) {
  const groupId = platform === "win32" ? undefined : child.pid;
  const initial = groupId === undefined
    ? child.pid === undefined
      ? []
      : await descendantProcesses(child.pid)
    : (await processGroupProcesses(groupId)).filter(({ pid }) => pid !== child.pid);
  const hadDescendants = initial.length > 0;

  if (terminateRoot || hadDescendants) {
    signalOwnedProcessTree(child, groupId, initial, "SIGTERM");
  }

  let terminalResult = await waitForTerminal(terminal, terminateRoot ? 5_000 : 100);
  let live = groupId === undefined
    ? await waitForRecordedProcessesToStop(initial, 5_000)
    : await waitForProcessGroupToStop(groupId, 5_000);
  let forced = false;
  if (!terminalResult || live.length > 0) {
    forced = true;
    signalOwnedProcessTree(child, groupId, live, "SIGKILL");
    terminalResult ??= await waitForTerminal(terminal, 5_000);
    live = groupId === undefined
      ? await waitForRecordedProcessesToStop(live, 5_000)
      : await waitForProcessGroupToStop(groupId, 5_000);
  }
  if (!terminalResult || live.length > 0) {
    throw new Error(
      `Captured command process tree survived cleanup: ${live.map(({ pid }) => pid).join(", ") || child.pid || "unknown"}.`,
    );
  }
  return {
    hadDescendants,
    recordedDescendants: initial.length,
    forced,
  };
}

function signalOwnedProcessTree(child, groupId, recorded, signal) {
  if (groupId !== undefined) {
    try {
      process.kill(-groupId, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
  signalRecordedProcesses(recorded, signal);
}

function captureChildOutput(child, maxOutputBytes = 256 * 1024) {
  const logs = { stdout: "", stderr: "" };
  const append = (name, chunk) => {
    logs[name] = `${logs[name]}${chunk.toString("utf8")}`.slice(-maxOutputBytes);
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
  const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureChildOutput(child);
  const terminal = captureChildTerminal(child);
  let result = await waitForTerminal(terminal, 10_000);
  if (!result) {
    child.kill("SIGKILL");
    result = await waitForTerminal(terminal, 5_000);
  }
  if (!result) {
    throw new Error("ps remained alive after SIGKILL.");
  }
  if (result.error) {
    throw new Error(`ps failed to start: ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `ps failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}.\n${logs.stderr}`,
    );
  }
  return logs.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }));
}

async function processGroupProcesses(groupId) {
  return (await processTable()).filter(({ pgid }) => pgid === groupId);
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

async function waitForProcessGroupToStop(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let live = await processGroupProcesses(groupId);
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    live = await processGroupProcesses(groupId);
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
