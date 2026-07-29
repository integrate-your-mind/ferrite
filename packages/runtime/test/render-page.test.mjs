import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createServerActionRequest, validateServerActionResponse } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const buildClientScript = join(workspaceRoot, "packages/runtime/bin/build-client.mjs");
const renderPageScript = join(workspaceRoot, "packages/runtime/bin/render-page.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");
const CLOUDFLARE_BUILD_ID = `sha256:${"a".repeat(64)}`;

async function withTempProject(run) {
  const projectRoot = await mkdtemp(join(tmpdir(), "ferrite-render-page-"));
  try {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2),
    );
    await linkRuntimePackage(projectRoot);
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function linkRuntimePackage(projectRoot) {
  const scopeDir = join(projectRoot, "node_modules/@ferrite");
  await mkdir(scopeDir, { recursive: true });
  await symlink(runtimePackage, join(scopeDir, "runtime"), platform === "win32" ? "junction" : "dir");
}

async function renderPage(projectRoot, pageFile, props = {}) {
  return renderPageMode(projectRoot, "render", pageFile, props);
}

async function renderPageMode(projectRoot, mode, pageFile, props = {}) {
  const args = mode === "render"
    ? [renderPageScript, pageFile, JSON.stringify(props), "[]"]
    : [renderPageScript, mode, pageFile, JSON.stringify(props), "[]"];
  const { stdout } = await execFileAsync(
    "node",
    args,
    {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

async function renderPageAction(projectRoot, pageFile, request, props = {}) {
  const { stdout } = await execFileAsync(
    "node",
    [renderPageScript, "--server-action", pageFile, JSON.stringify(props), "[]", "{}", JSON.stringify(request)],
    {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024,
    },
  );
  return validateServerActionResponse(JSON.parse(stdout));
}

async function renderPageActionManifest(projectRoot, pageFile, props = {}) {
  const { stdout } = await execFileAsync(
    "node",
    [renderPageScript, "--server-action-manifest", pageFile, JSON.stringify(props), "[]"],
    {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

async function buildCloudflareArtifact(projectRoot, pageFile, outputFile, {
  layouts = [],
  document = null,
  conventions = {},
  routePattern = "/",
  cloudflareMetadata = {
    sourceBuildId: CLOUDFLARE_BUILD_ID,
    assetBuildId: CLOUDFLARE_BUILD_ID,
    fallbackPath: "/index.html",
    observedActions: [],
  },
} = {}) {
  await execFileAsync(
    "node",
    [
      renderPageScript,
      "--build-cloudflare-artifact",
      pageFile,
      outputFile,
      JSON.stringify(layouts),
      JSON.stringify(document),
      JSON.stringify(conventions),
      routePattern,
      JSON.stringify(cloudflareMetadata),
    ],
    {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024,
    },
  );
}

async function buildClient(projectRoot, pageFile) {
  return buildClientTo(projectRoot, pageFile, join(projectRoot, "out"));
}

async function buildClientTo(
  projectRoot,
  pageFile,
  outDir,
  { routePath = "/", props = {}, layouts = [], options = {} } = {},
) {
  const { stdout } = await execFileAsync(
    "node",
    [
      buildClientScript,
      pageFile,
      outDir,
      "/_ferrite/static",
      routePath,
      JSON.stringify(props),
      JSON.stringify(layouts),
      JSON.stringify(options),
    ],
    { cwd: projectRoot, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function readBundleOutputs(outDir, bundle) {
  const outputs = {};
  for (const output of bundle.outputs) {
    outputs[output] = (await readFile(join(outDir, output))).toString("base64");
  }
  return outputs;
}

function sourceSnapshotValue(bundle, file) {
  return bundle.inputSnapshot.find(
    (input) => input.kind === "source" && input.path === file,
  )?.value;
}

function resolutionSnapshotValue(bundle, file) {
  return bundle.inputSnapshot.find(
    (input) => input.kind === "resolution" && input.path === file,
  )?.value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function assertPublishedSourceMaps(projectRoot, outDir, bundle) {
  for (const output of bundle.sourcemaps) {
    const mapPath = join(outDir, output);
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
    assert.equal(sourceMap.sources.length, sourceMap.sourcesContent.length);
    for (const [index, source] of sourceMap.sources.entries()) {
      const sourcePath = resolve(
        dirname(mapPath),
        decodeURIComponent(sourceMap.sourceRoot ?? ""),
        decodeURIComponent(source),
      );
      assert.doesNotMatch(sourcePath, /\.ferrite-client-build-/);
      if (sourcePath.startsWith(join(projectRoot, ".ferrite/generated/"))) {
        assert.equal(typeof sourceMap.sourcesContent[index], "string");
      } else {
        assert.equal((await stat(sourcePath)).isFile(), true, `${source} must resolve from ${output}`);
      }
    }
  }
}

async function waitForDirectoryWithPrefix(root, prefix) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(prefix))) {
        return;
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(1);
  }
  throw new Error(`Timed out waiting for ${prefix} in ${root}`);
}

test("build-client reports deterministic module-graph cycles and unresolved imports", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `import "./a"; export default function Page() { return null; }\n`);
    await writeFile(join(projectRoot, "app/a.ts"), `import "./b"; export const a = 1;\n`);
    await writeFile(join(projectRoot, "app/b.ts"), `import "./a"; export const b = 1;\n`);

    await assert.rejects(
      buildClient(projectRoot, pageFile),
      /Ferrite module graph cycle: app\/a\.ts -> app\/b\.ts -> app\/a\.ts/,
    );

    await writeFile(join(projectRoot, "app/a.ts"), `import "./missing"; export const a = 1;\n`);
    await assert.rejects(
      buildClient(projectRoot, pageFile),
      /Ferrite module graph could not resolve "\.\/missing" from app\/a\.ts/,
    );

    const outsideFile = `${projectRoot}-outside.ts`;
    try {
      await writeFile(outsideFile, `export const outside = true;\n`);
      await writeFile(
        join(projectRoot, "app/a.ts"),
        `import ${JSON.stringify(relative(join(projectRoot, "app"), outsideFile))}; export const a = 1;\n`,
      );
      await assert.rejects(
        buildClient(projectRoot, pageFile),
        /Ferrite module graph import escapes the project root: "(?:\.\.\/)+ferrite-render-page-/,
      );

      await symlink(outsideFile, join(projectRoot, "app/linked.ts"));
      await writeFile(join(projectRoot, "app/a.ts"), `import "./linked"; export const a = 1;\n`);
      await assert.rejects(
        buildClient(projectRoot, pageFile),
        /Ferrite module graph import escapes the project root: "\.\/linked" from app\/a\.ts/,
      );
    } finally {
      await rm(outsideFile, { force: true });
    }
  });
});

test("build-cloudflare-artifact emits an isolate-targeted route module with only the runtime async context external", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const outputFile = join(projectRoot, "out/route.mjs");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        "let renders = 0;",
        "export default function Page() {",
        "  renders += 1;",
        "  return <main data-render={renders}>Ferrite & Workers</main>;",
        "}",
        "",
      ].join("\n"),
    );

    await buildCloudflareArtifact(projectRoot, pageFile, outputFile);
    const source = await readFile(outputFile, "utf8");
    assert.match(source, /node:async_hooks/);
    assert.doesNotMatch(source, /node:(?:child_process|fs|http|path)/);

    const route = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
    assert.equal(route.routePattern, "/");
    assert.deepEqual(route.cloudflare, {
      format: "ferrite-cloudflare-route",
      version: 1,
      sourceBuildId: CLOUDFLARE_BUILD_ID,
      assetBuildId: CLOUDFLARE_BUILD_ID,
      path: "/",
      fallbackPath: "/index.html",
      observedActions: [],
    });
    const first = await route.serverRuntime.renderPageModuleToPacket(
      route.pageModule,
      {},
      route.layoutModules,
      route.conventionModules,
      { routePath: "/", routePattern: "/" },
    );
    const second = await route.serverRuntime.renderPageModuleToPacket(
      route.pageModule,
      {},
      route.layoutModules,
      route.conventionModules,
      { routePath: "/", routePattern: "/" },
    );
    assert.equal(first.root[2]["data-render"], 1);
    assert.equal(second.root[2]["data-render"], 2);
  });
});

test("build-cloudflare-artifact requires manifest-bound identity and rejects observed server actions", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const outputFile = join(projectRoot, "out/route.mjs");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, "export default function Page() { return <main>Edge</main>; }\n");

    await assert.rejects(
      execFileAsync(
        "node",
        [
          renderPageScript,
          "--build-cloudflare-artifact",
          pageFile,
          outputFile,
          "[]",
          "null",
          "{}",
          "/",
        ],
        { cwd: projectRoot, maxBuffer: 1024 * 1024 },
      ),
      /require metadata JSON/,
    );
    await assert.rejects(
      buildCloudflareArtifact(projectRoot, pageFile, outputFile, {
        cloudflareMetadata: {
          sourceBuildId: CLOUDFLARE_BUILD_ID,
          assetBuildId: CLOUDFLARE_BUILD_ID,
          fallbackPath: "/index.html",
          observedActions: ["save"],
        },
      }),
      /do not support routes with observed server actions/,
    );
  });
});

test("build-cloudflare-artifact rejects application Node builtins instead of shipping a false edge claim", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const outputFile = join(projectRoot, "out/route.mjs");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        'import { readFile } from "node:fs/promises";',
        "export default function Page() {",
        "  return <main>{typeof readFile}</main>;",
        "}",
        "",
      ].join("\n"),
    );

    await assert.rejects(
      buildCloudflareArtifact(projectRoot, pageFile, outputFile),
      /cannot import Node builtin "node:fs\/promises"/,
    );
  });
});

test("build-client emits a complete module graph and refreshes it after dependency changes", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const sharedFile = join(projectRoot, "app/shared.ts");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `// import "./missing"\nimport "./shared"; export default function Page() { return null; }\n`);
    await writeFile(sharedFile, `import Counter from "./Counter"; void import("./Lazy.mjs"); export { Counter };\n`);
    await writeFile(
      join(projectRoot, "app/Counter.tsx"),
      `"use client"; import Button from "./Button"; export default function Counter() { return <Button />; }\n`,
    );
    await writeFile(join(projectRoot, "app/Button.tsx"), `export default function Button() { return <button>One</button>; }\n`);
    await writeFile(join(projectRoot, "app/Lazy.mts"), `export const lazy = true;\n`);

    const first = await buildClient(projectRoot, pageFile);
    assert.deepEqual(first.moduleGraph, [
      { file: "app/Button.tsx", imports: [] },
      { file: "app/Counter.tsx", imports: ["app/Button.tsx"] },
      { file: "app/Lazy.mts", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/shared.ts"],
        watchFiles: ["app/shared.tsx", "tsconfig.json"],
      },
      {
        file: "app/shared.ts",
        imports: ["app/Counter.tsx", "app/Lazy.mts"],
        watchFiles: ["app/Lazy.mjs"],
      },
    ]);
    assert.deepEqual(first.clientReferences.map((reference) => reference.id), ["app/Counter.tsx#default"]);

    await writeFile(sharedFile, `import Counter from "./CounterTwo"; export { Counter };\n`);
    await writeFile(
      join(projectRoot, "app/CounterTwo.tsx"),
      `"use client"; export default function Counter() { return <button>Two</button>; }\n`,
    );

    const second = await buildClient(projectRoot, pageFile);
    assert.deepEqual(second.moduleGraph, [
      { file: "app/CounterTwo.tsx", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/shared.ts"],
        watchFiles: ["app/shared.tsx", "tsconfig.json"],
      },
      { file: "app/shared.ts", imports: ["app/CounterTwo.tsx"] },
    ]);
    assert.deepEqual(second.clientReferences.map((reference) => reference.id), ["app/CounterTwo.tsx#default"]);
  });
});

test("build-client snapshots every CSS, JSON, text, and WASM input esbuild consumes", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const cssFile = join(projectRoot, "app/style.css");
    const jsonFile = join(projectRoot, "app/data.json");
    const textFile = join(projectRoot, "app/copy.txt");
    const wasmFile = join(projectRoot, "app/module.wasm");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `"use client";`,
        `import data from "./data.json";`,
        `import copy from "./copy.txt";`,
        `import wasmUrl from "./module.wasm";`,
        `import "./style.css";`,
        `export default function Page() { return <main data-wasm={wasmUrl}>{data.label}: {copy}</main>; }`,
        "",
      ].join("\n"),
    );
    const initialCss = ".page { color: red; }\n";
    const initialJson = '{ "label": "first" }\n';
    const initialText = "first copy\n";
    const initialWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    await writeFile(cssFile, initialCss);
    await writeFile(jsonFile, initialJson);
    await writeFile(textFile, initialText);
    await writeFile(wasmFile, initialWasm);

    const canonicalCss = await realpath(cssFile);
    const canonicalJson = await realpath(jsonFile);
    const canonicalText = await realpath(textFile);
    const canonicalWasm = await realpath(wasmFile);
    const first = await buildClient(projectRoot, pageFile);
    assert.equal(sourceSnapshotValue(first, canonicalCss), sha256(initialCss));
    assert.equal(sourceSnapshotValue(first, canonicalJson), sha256(initialJson));
    assert.equal(sourceSnapshotValue(first, canonicalText), sha256(initialText));
    assert.equal(sourceSnapshotValue(first, canonicalWasm), sha256(initialWasm));
    const firstOutputs = await readBundleOutputs(join(projectRoot, "out"), first);

    const changedJson = '{ "label": "second" }\n';
    await writeFile(jsonFile, changedJson);
    const afterJson = await buildClient(projectRoot, pageFile);
    assert.equal(sourceSnapshotValue(afterJson, canonicalJson), sha256(changedJson));
    assert.notDeepEqual(
      firstOutputs,
      await readBundleOutputs(join(projectRoot, "out"), afterJson),
    );

    const changedCss = ".page { color: blue; }\n";
    await writeFile(cssFile, changedCss);
    const afterCss = await buildClient(projectRoot, pageFile);
    assert.equal(sourceSnapshotValue(afterCss, canonicalCss), sha256(changedCss));
    assert.notEqual(sourceSnapshotValue(afterCss, canonicalCss), sourceSnapshotValue(afterJson, canonicalCss));

    const changedText = "second copy\n";
    await writeFile(textFile, changedText);
    const afterText = await buildClient(projectRoot, pageFile);
    assert.equal(sourceSnapshotValue(afterText, canonicalText), sha256(changedText));
    assert.notEqual(
      sourceSnapshotValue(afterText, canonicalText),
      sourceSnapshotValue(afterCss, canonicalText),
    );

    const changedWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1]);
    await writeFile(wasmFile, changedWasm);
    const afterWasm = await buildClient(projectRoot, pageFile);
    assert.equal(sourceSnapshotValue(afterWasm, canonicalWasm), sha256(changedWasm));
    assert.notEqual(
      sourceSnapshotValue(afterWasm, canonicalWasm),
      sourceSnapshotValue(afterText, canonicalWasm),
    );
  });
});

test("build-client snapshots asset symlink resolution and canonical bytes", { skip: platform === "win32" }, async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const dataLink = join(projectRoot, "app/data.json");
    const dataA = join(projectRoot, "app/data-a.json");
    const dataB = join(projectRoot, "app/data-b.json");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import data from "./data.json"; export default function Page() { return <main>{data.label}</main>; }\n`,
    );
    await writeFile(dataA, '{ "label": "A" }\n');
    await writeFile(dataB, '{ "label": "B" }\n');
    await symlink("data-a.json", dataLink);

    const canonicalProjectRoot = await realpath(projectRoot);
    const canonicalDataA = await realpath(dataA);
    const bundle = await buildClient(projectRoot, pageFile);

    assert.equal(
      resolutionSnapshotValue(bundle, join(canonicalProjectRoot, "app/data.json")),
      "resolved:app/data-a.json",
    );
    assert.equal(sourceSnapshotValue(bundle, canonicalDataA), sha256('{ "label": "A" }\n'));

    await rm(dataLink);
    await symlink("data-b.json", dataLink);
    assert.equal(await realpath(dataLink), await realpath(dataB));
  });
});

test("build-client snapshots esbuild inputs with import suffixes", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const dataFile = join(projectRoot, "app/data.json");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import data from "./data.json?variant"; export default function Page() { return <main>{data.label}</main>; }\n`,
    );
    await writeFile(dataFile, '{ "label": "suffix" }\n');

    const canonicalData = await realpath(dataFile);
    const bundle = await buildClient(projectRoot, pageFile);

    assert.equal(sourceSnapshotValue(bundle, canonicalData), sha256('{ "label": "suffix" }\n'));
  });
});

test("build-client snapshots suffixed asset symlink resolution", { skip: platform === "win32" }, async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const dataLink = join(projectRoot, "app/data.json");
    const dataA = join(projectRoot, "app/data-a.json");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import data from "./data.json?variant"; export default function Page() { return <main>{data.label}</main>; }\n`,
    );
    await writeFile(dataA, '{ "label": "A" }\n');
    await writeFile(join(projectRoot, "app/data-b.json"), '{ "label": "B" }\n');
    await symlink("data-a.json", dataLink);

    const canonicalProjectRoot = await realpath(projectRoot);
    const canonicalDataA = await realpath(dataA);
    const bundle = await buildClient(projectRoot, pageFile);

    assert.equal(
      resolutionSnapshotValue(bundle, join(canonicalProjectRoot, "app/data.json")),
      "resolved:app/data-a.json",
    );
    assert.equal(sourceSnapshotValue(bundle, canonicalDataA), sha256('{ "label": "A" }\n'));
  });
});

test("build-client snapshots nested CSS asset symlink resolution", { skip: platform === "win32" }, async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const iconLink = join(projectRoot, "app/icon.svg");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import "./style.css"; export default function Page() { return <main className="icon" />; }\n`,
    );
    await writeFile(join(projectRoot, "app/style.css"), `.icon { background-image: url(icon.svg#mark); }\n`);
    await writeFile(join(projectRoot, "app/icon-a.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><g id="mark"/></svg>\n`);
    await symlink("icon-a.svg", iconLink);

    const canonicalProjectRoot = await realpath(projectRoot);
    const bundle = await buildClient(projectRoot, pageFile);

    assert.equal(
      resolutionSnapshotValue(bundle, join(canonicalProjectRoot, "app/icon.svg")),
      "resolved:app/icon-a.svg",
    );
  });
});

test("build-client distinguishes outside-project asset symlink targets", { skip: platform === "win32" }, async () => {
  const externalRoot = await mkdtemp(join(tmpdir(), "ferrite-external-assets-"));
  try {
    await withTempProject(async (projectRoot) => {
      const pageFile = join(projectRoot, "app/page.tsx");
      const dataLink = join(projectRoot, "app/data.json");
      const dataA = join(externalRoot, "data-a.json");
      const dataB = join(externalRoot, "data-b.json");
      await mkdir(dirname(pageFile), { recursive: true });
      await writeFile(
        pageFile,
        `"use client"; import data from "./data.json"; export default function Page() { return <main>{data.label}</main>; }\n`,
      );
      await writeFile(dataA, '{ "label": "A" }\n');
      await writeFile(dataB, '{ "label": "B" }\n');
      await symlink(dataA, dataLink);

      const canonicalProjectRoot = await realpath(projectRoot);
      const snapshotPath = join(canonicalProjectRoot, "app/data.json");
      const first = await buildClient(projectRoot, pageFile);
      const firstResolution = resolutionSnapshotValue(first, snapshotPath);

      await rm(dataLink);
      await symlink(dataB, dataLink);
      const second = await buildClient(projectRoot, pageFile);
      const secondResolution = resolutionSnapshotValue(second, snapshotPath);

      assert.match(firstResolution, /^outside-project:sha256:[a-f0-9]{64}$/);
      assert.match(secondResolution, /^outside-project:sha256:[a-f0-9]{64}$/);
      assert.notEqual(secondResolution, firstResolution);
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("build-client accepts deterministic data URL modules", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import message from "data:text/javascript,export default 'inline'"; export default function Page() { return <main>{message}</main>; }\n`,
    );

    const canonicalPage = await realpath(pageFile);
    const bundle = await buildClient(projectRoot, pageFile);

    assert.ok(bundle.script);
    assert.ok(bundle.inputSnapshot.some((input) => input.kind === "source" && input.path === canonicalPage));
  });
});

test("build-client rejects extensionless module candidates that esbuild does not resolve", async () => {
  for (const extension of [".mts", ".cts", ".mjs", ".cjs"]) {
    for (const dependencyPath of [`dependency${extension}`, join("dependency", `index${extension}`)]) {
      await withTempProject(async (projectRoot) => {
        const pageFile = join(projectRoot, "app/page.tsx");
        const dependencyFile = join(projectRoot, "app", dependencyPath);
        await mkdir(dirname(pageFile), { recursive: true });
        await mkdir(dirname(dependencyFile), { recursive: true });
        await writeFile(pageFile, `import "./dependency"; export default function Page() { return null; }\n`);
        await writeFile(dependencyFile, `export const value = 1;\n`);

        await assert.rejects(
          buildClient(projectRoot, pageFile),
          /Ferrite module graph could not resolve "\.\/dependency" from app\/page\.tsx/,
        );
      });
    }
  }
});

test("build-client preserves runtime-file precedence with TypeScript source fallbacks", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `"use client";`,
        `import "./server.js";`,
        `import "./view.jsx";`,
        `import "./modern.mjs";`,
        `import "./legacy.cjs";`,
        `export default function Page() { return null; }`,
        "",
      ].join("\n"),
    );
    await writeFile(
      join(projectRoot, "app/server.js"),
      `globalThis.__ferriteExtensionSource = "FERRITE_JS_RUNTIME_SELECTED";\n`,
    );
    await writeFile(
      join(projectRoot, "app/server.ts"),
      `globalThis.__ferriteExtensionSource = "FERRITE_TS_SOURCE_SELECTED";\n`,
    );
    await writeFile(join(projectRoot, "app/view.tsx"), `export const view = "tsx";\n`);
    await writeFile(join(projectRoot, "app/modern.mts"), `export const mode = "esm";\n`);
    await writeFile(join(projectRoot, "app/legacy.cts"), `export const mode = "commonjs";\n`);

    const bundle = await buildClient(projectRoot, pageFile);

    assert.deepEqual(bundle.moduleGraph, [
      { file: "app/legacy.cts", imports: [] },
      { file: "app/modern.mts", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/legacy.cts", "app/modern.mts", "app/server.js", "app/view.tsx"],
        watchFiles: ["app/legacy.cjs", "app/modern.mjs", "app/view.jsx", "tsconfig.json"],
      },
      { file: "app/server.js", imports: [] },
      { file: "app/view.tsx", imports: [] },
    ]);
    const scriptOutput = bundle.outputs.find((output) => output.endsWith(".js"));
    assert.ok(scriptOutput, "client route should emit a JavaScript bundle");
    const script = await readFile(join(projectRoot, "out", scriptOutput), "utf8");
    assert.match(script, /FERRITE_JS_RUNTIME_SELECTED/);
    assert.doesNotMatch(script, /FERRITE_TS_SOURCE_SELECTED/);
  });
});

test("build-client excludes emit-erased type-only imports from the runtime module graph", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `import "./server"; export default function Page() { return null; }\n`);
    await writeFile(
      join(projectRoot, "app/server.ts"),
      [
        `import { type ClientProps, LegacyProps, Widget } from "./Client";`,
        `import { type GhostProps } from "./GhostClient";`,
        `import { type DeclarationOnlyProps } from "./declarations";`,
        `export { type ReexportedProps } from "./ReexportClient";`,
        `type LegacyAlias = LegacyProps;`,
        `export { Widget };`,
        `export type { ClientProps, DeclarationOnlyProps, GhostProps, LegacyAlias };`,
        "",
      ].join("\n"),
    );
    await writeFile(
      join(projectRoot, "app/Client.tsx"),
      `"use client"; export type ClientProps = {}; export type LegacyProps = {}; export function Widget() { return null; }\n`,
    );
    await writeFile(
      join(projectRoot, "app/GhostClient.tsx"),
      `"use client"; export type GhostProps = {}; export function Ghost() { return null; }\n`,
    );
    await writeFile(
      join(projectRoot, "app/ReexportClient.tsx"),
      `"use client"; export type ReexportedProps = {}; export function Reexported() { return null; }\n`,
    );
    await writeFile(
      join(projectRoot, "app/declarations.d.ts"),
      `export interface DeclarationOnlyProps { value: string; }\n`,
    );

    const bundle = await buildClient(projectRoot, pageFile);

    assert.deepEqual(bundle.moduleGraph, [
      { file: "app/Client.tsx", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/server.ts"],
        watchFiles: ["app/server.tsx", "tsconfig.json"],
      },
      { file: "app/server.ts", imports: ["app/Client.tsx"] },
    ]);
    assert.deepEqual(bundle.clientReferences.map((reference) => reference.id), ["app/Client.tsx#Widget"]);
  });
});

test("build-client honors verbatimModuleSyntax when deriving runtime graph edges", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const serverFile = join(projectRoot, "app/server.ts");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      join(projectRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }, null, 2),
    );
    await writeFile(pageFile, `import "./server"; export default function Page() { return null; }\n`);
    await writeFile(
      serverFile,
      `import { Widget } from "./Client"; export type WidgetType = typeof Widget;\n`,
    );
    await writeFile(
      join(projectRoot, "app/Client.tsx"),
      `"use client"; export function Widget() { return null; }\n`,
    );

    const preserved = await buildClient(projectRoot, pageFile);
    assert.deepEqual(preserved.moduleGraph, [
      { file: "app/Client.tsx", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/server.ts"],
        watchFiles: ["app/server.tsx", "tsconfig.json"],
      },
      { file: "app/server.ts", imports: ["app/Client.tsx"] },
    ]);
    assert.deepEqual(preserved.clientReferences.map((reference) => reference.id), ["app/Client.tsx#Widget"]);

    await writeFile(
      serverFile,
      `import type { Widget } from "./Client"; export type WidgetType = typeof Widget;\n`,
    );
    const erased = await buildClient(projectRoot, pageFile);
    assert.deepEqual(erased.moduleGraph, [
      {
        file: "app/page.tsx",
        imports: ["app/server.ts"],
        watchFiles: ["app/server.tsx", "tsconfig.json"],
      },
      { file: "app/server.ts", imports: [] },
    ]);
    assert.deepEqual(erased.clientReferences, []);
  });
});

test("build-client reports malformed or unresolved TypeScript configuration", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const configFile = join(projectRoot, "tsconfig.json");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `export default function Page() { return null; }\n`);

    await writeFile(configFile, `{ "compilerOptions": {`);
    await assert.rejects(buildClient(projectRoot, pageFile), /could not read tsconfig\.json/);

    await writeFile(configFile, JSON.stringify({ extends: "./missing-tsconfig.json" }, null, 2));
    await assert.rejects(buildClient(projectRoot, pageFile), /could not load tsconfig\.json/);
  });
});

test("build-client snapshots a missing TypeScript configuration input", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `export default function Page() { return null; }\n`);

    const bundle = await buildClient(projectRoot, pageFile);
    const canonicalProjectRoot = await realpath(projectRoot);

    assert.deepEqual(
      bundle.inputSnapshot.filter((entry) => entry.path === join(canonicalProjectRoot, "tsconfig.json")),
      [{ kind: "source", path: join(canonicalProjectRoot, "tsconfig.json"), value: "missing" }],
    );
  });
});

test("build-client snapshots inherited TypeScript configuration outside the project root", async () => {
  const container = await mkdtemp(join(tmpdir(), "ferrite-shared-tsconfig-"));
  const projectRoot = join(container, "project");
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await linkRuntimePackage(projectRoot);
    const baseConfig = join(container, "tsconfig.base.json");
    await writeFile(baseConfig, JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }));
    await writeFile(join(projectRoot, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.base.json" }));
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `export default function Page() { return null; }\n`);

    const bundle = await buildClient(projectRoot, pageFile);
    const canonicalBaseConfig = await realpath(baseConfig);
    const inherited = bundle.inputSnapshot.find((entry) => entry.path === canonicalBaseConfig);

    assert.equal(inherited?.kind, "source");
    assert.match(inherited?.value ?? "", /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("build-client snapshots additional production render roots and their imports", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const documentFile = join(projectRoot, "app/document.tsx");
    const documentDependency = join(projectRoot, "app/document-shell.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `export default function Page() { return null; }\n`);
    await writeFile(
      documentFile,
      `import { shell } from "./document-shell"; export default function Document() { return shell; }\n`,
    );
    await writeFile(documentDependency, `export const shell = "document";\n`);

    const outDir = join(projectRoot, "out");
    const { stdout } = await execFileAsync(
      "node",
      [
        buildClientScript,
        pageFile,
        outDir,
        "/_ferrite/static",
        "/",
        "{}",
        "[]",
        JSON.stringify({ snapshotFiles: [documentFile] }),
      ],
      { cwd: projectRoot, maxBuffer: 1024 * 1024 },
    );
    const bundle = JSON.parse(stdout);
    const canonicalDocument = await realpath(documentFile);
    const canonicalDependency = await realpath(documentDependency);

    assert.match(
      bundle.inputSnapshot.find((entry) => entry.path === canonicalDocument && entry.kind === "source")?.value ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      bundle.inputSnapshot.find((entry) => entry.path === canonicalDependency && entry.kind === "source")?.value ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepEqual(
      bundle.moduleGraph.filter((node) => node.file.startsWith("app/document")),
      [
        { file: "app/document-shell.tsx", imports: [] },
        {
          file: "app/document.tsx",
          imports: ["app/document-shell.tsx"],
          watchFiles: ["tsconfig.json"],
        },
      ],
    );
  });
});

test("build-client emits byte-identical generated entries across repeated builds", async () => {
  await withTempProject(async (projectRoot) => {
    const clientRoute = join(projectRoot, "app/client/page.tsx");
    const referenceRoute = join(projectRoot, "app/reference/page.tsx");
    const clientReference = join(projectRoot, "app/reference/Client.tsx");
    const actionRoute = join(projectRoot, "app/action/page.tsx");
    await mkdir(dirname(clientRoute), { recursive: true });
    await mkdir(dirname(referenceRoute), { recursive: true });
    await mkdir(dirname(actionRoute), { recursive: true });
    await writeFile(
      clientRoute,
      `"use client"; export default function Page() { return <button>client</button>; }\n`,
    );
    await writeFile(
      referenceRoute,
      `import Client from "./Client"; export default function Page() { return <Client />; }\n`,
    );
    await writeFile(
      clientReference,
      `"use client"; export default function Client() { return <button>reference</button>; }\n`,
    );
    await writeFile(actionRoute, `export default function Page() { return <main>action</main>; }\n`);

    const cases = [
      { name: "client-route", pageFile: clientRoute, options: { runtimeProps: true } },
      { name: "client-reference", pageFile: referenceRoute, options: {} },
      { name: "action-bootstrap", pageFile: actionRoute, options: { actionBootstrap: true } },
    ];
    for (const buildCase of cases) {
      const firstOut = join(projectRoot, "repeated", `${buildCase.name}-first`);
      const secondOut = join(projectRoot, "repeated", `${buildCase.name}-second`);
      const buildOptions = {
        routePath: `/${buildCase.name}`,
        options: buildCase.options,
      };
      const first = await buildClientTo(projectRoot, buildCase.pageFile, firstOut, buildOptions);
      const second = await buildClientTo(projectRoot, buildCase.pageFile, secondOut, buildOptions);

      assert.deepEqual(second, first, `${buildCase.name} metadata must be deterministic`);
      assert.deepEqual(
        await readBundleOutputs(secondOut, second),
        await readBundleOutputs(firstOut, first),
        `${buildCase.name} output bytes must be deterministic`,
      );
      await assertPublishedSourceMaps(projectRoot, firstOut, first);
      await assertPublishedSourceMaps(projectRoot, secondOut, second);
      for (const [output, encoded] of Object.entries(await readBundleOutputs(firstOut, first))) {
        if (output.endsWith(".js") || output.endsWith(".map")) {
          const contents = Buffer.from(encoded, "base64").toString("utf8");
          assert.doesNotMatch(contents, /\.ferrite\/tmp\/(?:client|client-reference|action-bootstrap)-/);
          assert.doesNotMatch(contents, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
      }
    }
  });
});

test("build-client removes staged outputs after a bundling failure", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `"use client"; import "missing-production-dependency"; export default function Page() { return null; }\n`,
    );

    await assert.rejects(buildClient(projectRoot, pageFile), /Could not resolve/);
    assert.equal((await readdir(projectRoot)).some((entry) => entry.startsWith(".out.ferrite-client-build-")), false);
    assert.deepEqual(await readdir(join(projectRoot, "out")), []);
  });
});

test("build-client rejects symlinked output directories", { skip: platform === "win32" }, async () => {
  const outside = await mkdtemp(join(tmpdir(), "ferrite-output-escape-"));
  try {
    await withTempProject(async (projectRoot) => {
      const pageFile = join(projectRoot, "app/page.tsx");
      const outDir = join(projectRoot, "out");
      await mkdir(dirname(pageFile), { recursive: true });
      await writeFile(join(projectRoot, "app/mark.svg"), `<svg xmlns="http://www.w3.org/2000/svg"/>\n`);
      await writeFile(
        pageFile,
        `"use client"; import mark from "./mark.svg"; export default function Page() { return <img src={mark} />; }\n`,
      );
      await mkdir(outDir);
      await symlink(outside, join(outDir, "assets"));

      await assert.rejects(
        buildClientTo(projectRoot, pageFile, outDir),
        /output directory escapes or aliases its build directory/,
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal((await readdir(projectRoot)).some((entry) => entry.startsWith(".out.ferrite-client-build-")), false);
      assert.equal((await readdir(outDir)).some((entry) => entry.startsWith(".ferrite-publish-")), false);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("build-client rejects symlinked output files", { skip: platform === "win32" }, async () => {
  const outside = await mkdtemp(join(tmpdir(), "ferrite-output-file-escape-"));
  try {
    await withTempProject(async (projectRoot) => {
      const pageFile = join(projectRoot, "app/page.tsx");
      const outDir = join(projectRoot, "out");
      const routeIdentity = createHash("sha256").update("/").digest("hex").slice(0, 16);
      const routeOutput = `route-index-${routeIdentity}.js`;
      const outsideFile = join(outside, routeOutput);
      await mkdir(dirname(pageFile), { recursive: true });
      await writeFile(pageFile, `"use client"; export default function Page() { return null; }\n`);
      await mkdir(outDir);
      await writeFile(outsideFile, "sentinel\n");
      await symlink(outsideFile, join(outDir, routeOutput));

      await assert.rejects(
        buildClientTo(projectRoot, pageFile, outDir),
        /output destination is not a regular file/,
      );
      assert.equal(await readFile(outsideFile, "utf8"), "sentinel\n");
      assert.equal((await readdir(projectRoot)).some((entry) => entry.startsWith(".out.ferrite-client-build-")), false);
      assert.equal((await readdir(outDir)).some((entry) => entry.startsWith(".ferrite-publish-")), false);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("build-client preserves every prior output when a later destination is invalid", { skip: platform === "win32" }, async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const styleFile = join(projectRoot, "app/page.css");
    const outDir = join(projectRoot, "out");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(styleFile, ".label { color: red; }\n");
    await writeFile(
      pageFile,
      `"use client"; import "./page.css"; export default function Page() { return <p className="label">first</p>; }\n`,
    );

    const initial = await buildClientTo(projectRoot, pageFile, outDir);
    assert.ok(initial.outputs.length >= 2, "fixture must exercise multi-output publication");
    const initialOutputs = await readBundleOutputs(outDir, initial);
    const blockedOutput = initial.outputs.at(-1);
    const protectedFile = join(projectRoot, "protected-output");
    await writeFile(protectedFile, "sentinel\n");
    await rm(join(outDir, blockedOutput), { force: true });
    await symlink(protectedFile, join(outDir, blockedOutput));
    await writeFile(
      pageFile,
      `"use client"; import "./page.css"; export default function Page() { return <p className="label">second</p>; }\n`,
    );

    await assert.rejects(
      buildClientTo(projectRoot, pageFile, outDir),
      /output destination is not a regular file/,
    );
    for (const output of initial.outputs.slice(0, -1)) {
      assert.deepEqual((await readFile(join(outDir, output))).toString("base64"), initialOutputs[output]);
    }
    assert.equal(await readFile(protectedFile, "utf8"), "sentinel\n");
    assert.equal((await readdir(projectRoot)).some((entry) => entry.startsWith(".out.ferrite-client-build-")), false);
    assert.equal((await readdir(outDir)).some((entry) => entry.startsWith(".ferrite-publish-")), false);
  });
});

test("build-client includes two-argument dynamic imports in the runtime graph", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `import "./server"; export default function Page() { return null; }\n`);
    await writeFile(
      join(projectRoot, "app/server.ts"),
      `void import("./lazy", { with: { type: "javascript" } });\n`,
    );
    await writeFile(join(projectRoot, "app/lazy.ts"), `export const value = "lazy";\n`);

    const bundle = await buildClient(projectRoot, pageFile);
    assert.deepEqual(bundle.moduleGraph, [
      { file: "app/lazy.ts", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/server.ts"],
        watchFiles: ["app/server.tsx", "tsconfig.json"],
      },
      { file: "app/server.ts", imports: ["app/lazy.ts"], watchFiles: ["app/lazy.tsx"] },
    ]);
  });
});

test("build-client rejects ambiguous imports across use-client boundaries", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    const serverFile = join(projectRoot, "app/server.ts");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `import "./server"; export default function Page() { return null; }\n`);
    await writeFile(
      join(projectRoot, "app/Client.tsx"),
      `"use client"; export default function Client() { return null; } export const Named = Client;\n`,
    );

    const cases = [
      `import * as Client from "./Client"; void Client;`,
      `import "./Client";`,
      `void import("./Client", { with: {} });`,
      `const Client = require("./Client"); void Client;`,
      `import Client = require("./Client"); void Client;`,
      `export * from "./Client";`,
    ];
    for (const source of cases) {
      await writeFile(serverFile, `${source}\nexport const value = true;\n`);
      await assert.rejects(
        buildClient(projectRoot, pageFile),
        /must use concrete default or named imports\/exports/,
      );
    }
  });
});

test("build-client retries when a resolver input changes during bundling", { skip: platform === "win32" }, async () => {
  await withTempProject(async (projectRoot) => {
    const appDir = join(projectRoot, "app");
    const pageFile = join(appDir, "page.tsx");
    const clientLink = join(appDir, "Client.tsx");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      pageFile,
      `import Client from "./Client"; export default function Page() { return <Client />; }\n`,
    );
    const filler = Array.from({ length: 20_000 }, (_value, index) => `export const value${index} = ${index};`).join("\n");
    await writeFile(
      join(appDir, "ClientA.tsx"),
      `"use client";\n${filler}\nexport default function Client() { return null; }\n`,
    );
    await writeFile(
      join(appDir, "ClientB.tsx"),
      `"use client"; export default function Client() { return <button>stable</button>; }\n`,
    );
    await symlink("ClientA.tsx", clientLink);

    const build = buildClient(projectRoot, pageFile);
    await waitForDirectoryWithPrefix(projectRoot, ".out.ferrite-client-build-");
    await rm(clientLink);
    await symlink("ClientB.tsx", clientLink);
    const bundle = await build;

    assert.deepEqual(bundle.clientReferences.map((reference) => reference.id), ["app/ClientB.tsx#default"]);
    assert.deepEqual(bundle.moduleGraph, [
      { file: "app/ClientB.tsx", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/ClientB.tsx"],
        watchFiles: ["app/Client.tsx", "tsconfig.json"],
      },
    ]);
    assert.equal((await readdir(projectRoot)).some((entry) => entry.startsWith(".out.ferrite-client-build-")), false);
    assert.doesNotMatch((await readdir(join(projectRoot, "out"))).join("\n"), /ClientA/);
  });
});

test("build-client preserves server boundaries across shared client-subtree helpers", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      `import RootClient from "./RootClient"; export default function Page() { return <RootClient />; }\n`,
    );
    await writeFile(
      join(projectRoot, "app/RootClient.tsx"),
      `"use client"; import { helper } from "./helper"; export default function RootClient() { return helper; }\n`,
    );
    await writeFile(
      join(projectRoot, "app/helper.ts"),
      `import NestedClient from "./NestedClient"; export const helper = NestedClient;\n`,
    );
    await writeFile(
      join(projectRoot, "app/NestedClient.tsx"),
      `"use client"; export default function NestedClient() { return null; }\n`,
    );

    const clientOnly = await buildClient(projectRoot, pageFile);
    assert.deepEqual(
      clientOnly.clientReferences.map((reference) => reference.id),
      ["app/RootClient.tsx#default"],
    );

    await writeFile(
      pageFile,
      [
        `import RootClient from "./RootClient";`,
        `import { helper } from "./helper";`,
        `export default function Page() { void helper; return <RootClient />; }`,
        "",
      ].join("\n"),
    );
    const sharedWithServer = await buildClient(projectRoot, pageFile);
    assert.deepEqual(
      sharedWithServer.clientReferences.map((reference) => reference.id),
      ["app/NestedClient.tsx#default", "app/RootClient.tsx#default"],
    );
  });
});

test("build-client includes static CommonJS and TypeScript import-equals dependencies", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(pageFile, `import "./server"; export default function Page() { return null; }\n`);
    await writeFile(
      join(projectRoot, "app/server.ts"),
      `import legacy = require("./legacy.cjs"); export const value = legacy;\n`,
    );
    await writeFile(
      join(projectRoot, "app/legacy.cjs"),
      [
        `function load(require) { return require("./missing.cjs"); }`,
        `const nested = require("./nested.cjs");`,
        `module.exports = { load, nested };`,
        "",
      ].join("\n"),
    );
    await writeFile(join(projectRoot, "app/nested.cjs"), `module.exports = "nested";\n`);

    const bundle = await buildClient(projectRoot, pageFile);

    assert.deepEqual(bundle.moduleGraph, [
      { file: "app/legacy.cjs", imports: ["app/nested.cjs"] },
      { file: "app/nested.cjs", imports: [] },
      {
        file: "app/page.tsx",
        imports: ["app/server.ts"],
        watchFiles: ["app/server.tsx", "tsconfig.json"],
      },
      { file: "app/server.ts", imports: ["app/legacy.cjs"] },
    ]);
  });
});

test("render-page proxies nested use client imports into client reference markers", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    const clientFile = join(projectRoot, "app/posts/[id]/PostActions.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import PostActions from "./PostActions";`,
        "",
        `export default function Page({ params }) {`,
        `  return <article data-route="/posts/:id"><PostActions id={params.id} /></article>;`,
        `}`,
        "",
      ].join("\n"),
    );
    await writeFile(
      clientFile,
      [
        `"use client";`,
        "",
        `import { useState } from "@ferrite/runtime";`,
        "",
        `export default function PostActions({ id }) {`,
        `  const [likes] = useState(0);`,
        `  return <button type="button" data-client-island="post-actions">Like {id}: {likes}</button>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const packet = await renderPage(projectRoot, pageFile, { params: { id: "alpha" } });

    assert.deepEqual(packet, {
      ferrite: "render-packet",
      version: 1,
      root: [
        2,
        "article",
        { "data-route": "/posts/:id" },
        [
          [
            2,
            "span",
            {
              "data-ferrite-client-reference": "app/posts/[id]/PostActions.tsx#default",
              "data-ferrite-client-props": '{"id":"alpha"}',
              "data-ferrite-client-payload":
                '{"ferrite":"client-reference","version":1,"id":"app/posts/[id]/PostActions.tsx#default","module":"app/posts/[id]/PostActions.tsx","exportName":"default","props":{"id":"alpha"}}',
            },
            [
              [
                2,
                "button",
                { type: "button", "data-client-island": "post-actions" },
                [
                  [0, "Like "],
                  [0, "alpha"],
                  [0, ": "],
                  [0, "0"],
                ],
              ],
            ],
          ],
        ],
      ],
    });
  });
});

test("render-page invokes a registered server action", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { createServerAction } from "@ferrite/runtime/server";`,
        "",
        `export default function Page() {`,
        `  const savePost = createServerAction({`,
        `    id: "app/posts/[id]/page.tsx#savePost",`,
        `    routePattern: "/posts/:id",`,
        `    async run({ form, routePath }) {`,
        `      return { title: form.title, tags: form.tag, routePath };`,
        `    },`,
        `  });`,
        `  return <form action={savePost}><input name="title" /></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const response = await renderPageAction(
      projectRoot,
      pageFile,
      createServerActionRequest({
        id: "app/posts/[id]/page.tsx#savePost",
        routePath: "/posts/alpha",
        form: { title: "Hello", tag: ["rust", "tsx"] },
      }),
    );

    assert.deepEqual(response, {
      ferrite: "server-action-response",
      version: 1,
      status: "ok",
      data: {
        title: "Hello",
        tags: ["rust", "tsx"],
        routePath: "/posts/alpha",
      },
    });
  });
});

test("render-page emits registered server action manifest without invoking actions", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    const sideEffectFile = join(projectRoot, "side-effect.txt");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { writeFile } from "node:fs/promises";`,
        `import { createServerAction } from "@ferrite/runtime/server";`,
        "",
        `export default function Page({ params }) {`,
        `  const savePost = createServerAction({`,
        `    id: "app/posts/[id]/page.tsx#savePost",`,
        `    async run() {`,
        `      await writeFile(${JSON.stringify(sideEffectFile)}, "ran");`,
        `      return { ok: true };`,
        `    },`,
        `  });`,
        `  return <form action={savePost}><button type="submit">Save {params.id}</button></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const manifest = await renderPageActionManifest(projectRoot, pageFile, { params: { id: "alpha" } });

    assert.deepEqual(manifest, {
      routePath: "/posts/alpha",
      routePattern: "/posts/:id",
      actions: [
        {
          ferrite: "server-action-reference",
          version: 1,
          id: "app/posts/[id]/page.tsx#savePost",
          routePattern: "/posts/:id",
          url: "/_ferrite/action",
          bound: {},
        },
      ],
    });
    await assert.rejects(() => readFile(sideEffectFile, "utf8"), { code: "ENOENT" });
  });
});

test("render-page normalizes catch-all action route patterns and omits route groups", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/(content)/docs/[...slug]/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { createServerAction } from "@ferrite/runtime/server";`,
        "",
        `export default function Page() {`,
        `  const saveDoc = createServerAction({`,
        `    id: "app/(content)/docs/[...slug]/page.tsx#saveDoc",`,
        `    async run() { return { ok: true }; },`,
        `  });`,
        `  return <form action={saveDoc}><button type="submit">Save</button></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const manifest = await renderPageActionManifest(projectRoot, pageFile, {
      params: { slug: ["guides", "install"] },
    });

    assert.equal(manifest.routePath, "/docs/guides/install");
    assert.equal(manifest.routePattern, "/docs/*slug");
    assert.equal(manifest.actions[0]?.routePattern, "/docs/*slug");
  });
});

test("render-page rejects unknown server action ids without invoking actions", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    const sideEffectFile = join(projectRoot, "side-effect.txt");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { writeFile } from "node:fs/promises";`,
        `import { createServerAction } from "@ferrite/runtime/server";`,
        "",
        `export default function Page() {`,
        `  const savePost = createServerAction({`,
        `    id: "app/posts/[id]/page.tsx#savePost",`,
        `    routePattern: "/posts/:id",`,
        `    async run() {`,
        `      await writeFile(${JSON.stringify(sideEffectFile)}, "ran");`,
        `      return { ok: true };`,
        `    },`,
        `  });`,
        `  return <form action={savePost}><button type="submit">Save</button></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    await assert.rejects(
      () =>
        renderPageAction(
          projectRoot,
          pageFile,
          createServerActionRequest({
            id: "app/posts/[id]/page.tsx#missing",
            routePath: "/posts/alpha",
          }),
        ),
      (error) => {
        assert.match(error.stderr, /was not registered during route render/);
        return true;
      },
    );
    await assert.rejects(() => readFile(sideEffectFile, "utf8"), { code: "ENOENT" });
  });
});

test("render-page does not expose unexpected server action exceptions", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { createServerAction } from "@ferrite/runtime/server";`,
        "",
        `export default function Page() {`,
        `  const savePost = createServerAction({`,
        `    id: "app/posts/[id]/page.tsx#savePost",`,
        `    routePattern: "/posts/:id",`,
        `    async run() {`,
        `      throw new Error("Action exploded");`,
        `    },`,
        `  });`,
        `  return <form action={savePost}><button type="submit">Save</button></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    await assert.rejects(
      () =>
        renderPageAction(
          projectRoot,
          pageFile,
          createServerActionRequest({
            id: "app/posts/[id]/page.tsx#savePost",
            routePath: "/posts/alpha",
          }),
        ),
      (error) => {
        assert.match(error.stderr, /Action exploded/);
        assert.doesNotMatch(error.stdout, /Action exploded/);
        return true;
      },
    );
  });
});

test("render-page returns explicit public server action errors with stable codes", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import { createServerAction, FerriteActionError } from "@ferrite/runtime/server";`,
        "",
        `export default function Page() {`,
        `  const savePost = createServerAction({`,
        `    id: "app/posts/[id]/page.tsx#savePost",`,
        `    routePattern: "/posts/:id",`,
        `    async run() {`,
        `      throw new FerriteActionError("POST_CONFLICT", "Could not save post.");`,
        `    },`,
        `  });`,
        `  return <form action={savePost}><button type="submit">Save</button></form>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const response = await renderPageAction(
      projectRoot,
      pageFile,
      createServerActionRequest({
        id: "app/posts/[id]/page.tsx#savePost",
        routePath: "/posts/alpha",
      }),
    );

    assert.deepEqual(response, {
      ferrite: "server-action-response",
      version: 1,
      status: "error",
      code: "POST_CONFLICT",
      message: "Could not save post.",
    });
  });
});

test("render-page does not proxy a route entry with use client", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/page.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `"use client";`,
        "",
        `import { useState } from "@ferrite/runtime";`,
        "",
        `export default function Page() {`,
        `  const [count] = useState(0);`,
        `  return <button type="button">Client route {count}</button>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const packet = await renderPage(projectRoot, pageFile);

    assert.deepEqual(packet, {
      ferrite: "render-packet",
      version: 1,
      root: [
        2,
        "button",
        { type: "button" },
        [
          [0, "Client route "],
          [0, "0"],
        ],
      ],
    });
  });
});

test("render-page emits server payloads with imported client references", async () => {
  await withTempProject(async (projectRoot) => {
    const pageFile = join(projectRoot, "app/posts/[id]/page.tsx");
    const clientFile = join(projectRoot, "app/posts/[id]/PostActions.tsx");
    await mkdir(dirname(pageFile), { recursive: true });
    await writeFile(
      pageFile,
      [
        `import PostActions from "./PostActions";`,
        "",
        `export default function Page({ params }) {`,
        `  return <article data-route="/posts/:id"><PostActions id={params.id} /></article>;`,
        `}`,
        "",
      ].join("\n"),
    );
    await writeFile(
      clientFile,
      [
        `"use client";`,
        "",
        `export default function PostActions({ id }) {`,
        `  return <button type="button" data-client-island="post-actions">Like {id}: 0</button>;`,
        `}`,
        "",
      ].join("\n"),
    );

    const payload = await renderPageMode(projectRoot, "--server-payload", pageFile, { params: { id: "alpha" } });

    assert.equal(payload.ferrite, "server-payload");
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.clientReferences, [
      {
        ferrite: "client-reference",
        version: 1,
        id: "app/posts/[id]/PostActions.tsx#default",
        module: "app/posts/[id]/PostActions.tsx",
        exportName: "default",
        props: { id: "alpha" },
      },
    ]);
    assert.deepEqual(payload.chunks, []);
    assert.deepEqual(payload.shell, [
      2,
      "article",
      { "data-route": "/posts/:id" },
      [
        [
          2,
          "span",
          {
            "data-ferrite-client-reference": "app/posts/[id]/PostActions.tsx#default",
            "data-ferrite-client-props": '{"id":"alpha"}',
            "data-ferrite-client-payload":
              '{"ferrite":"client-reference","version":1,"id":"app/posts/[id]/PostActions.tsx#default","module":"app/posts/[id]/PostActions.tsx","exportName":"default","props":{"id":"alpha"}}',
          },
          [
            [
              2,
              "button",
              { type: "button", "data-client-island": "post-actions" },
              [
                [0, "Like "],
                [0, "alpha"],
                [0, ": 0"],
              ],
            ],
          ],
        ],
      ],
    ]);
  });
});
