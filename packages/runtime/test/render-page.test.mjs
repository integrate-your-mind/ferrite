import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createServerActionRequest, validateServerActionResponse } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const buildClientScript = join(workspaceRoot, "packages/runtime/bin/build-client.mjs");
const renderPageScript = join(workspaceRoot, "packages/runtime/bin/render-page.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");

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

async function buildClient(projectRoot, pageFile) {
  const outDir = join(projectRoot, "out");
  const { stdout } = await execFileAsync(
    "node",
    [buildClientScript, pageFile, outDir, "/_ferrite/static"],
    { cwd: projectRoot, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
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
      { file: "app/page.tsx", imports: ["app/shared.ts"] },
      { file: "app/shared.ts", imports: ["app/Counter.tsx", "app/Lazy.mts"] },
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
      { file: "app/page.tsx", imports: ["app/shared.ts"] },
      { file: "app/shared.ts", imports: ["app/CounterTwo.tsx"] },
    ]);
    assert.deepEqual(second.clientReferences.map((reference) => reference.id), ["app/CounterTwo.tsx#default"]);
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
      { file: "app/page.tsx", imports: ["app/server.ts"] },
      { file: "app/server.ts", imports: ["app/Client.tsx"] },
    ]);
    assert.deepEqual(bundle.clientReferences.map((reference) => reference.id), ["app/Client.tsx#Widget"]);
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
      { file: "app/page.tsx", imports: ["app/server.ts"] },
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

test("render-page returns sanitized error responses for thrown server actions", async () => {
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
      message: "Action exploded",
    });
    assert.equal(JSON.stringify(response).includes("at "), false);
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
