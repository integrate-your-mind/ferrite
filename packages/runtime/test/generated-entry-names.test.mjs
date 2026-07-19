import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const buildClient = join(workspaceRoot, "packages/runtime/bin/build-client.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), "ferrite-entry-names-"));
  try {
    await mkdir(join(project, "app"), { recursive: true });
    await mkdir(join(project, "node_modules/@ferrite"), { recursive: true });
    await symlink(runtimePackage, join(project, "node_modules/@ferrite/runtime"), platform === "win32" ? "junction" : "dir");
    await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "@ferrite/runtime",
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
        },
      }),
    );
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function build(project, pageFile, outDir, routePath) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [buildClient, pageFile, outDir, "/_ferrite/static", routePath, "{}", "[]", "{}"],
    { cwd: project, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test("route entry names include the full route identity hash", async () => {
  await withProject(async (project) => {
    const pageFile = join(project, "app/page.tsx");
    const outDir = join(project, "out");
    await writeFile(pageFile, `"use client"; export default function Page() { return <main>route</main>; }\n`);

    const dotted = await build(project, pageFile, outDir, "/a.b");
    const nested = await build(project, pageFile, outDir, "/a/b");
    assert.notEqual(dotted.script, nested.script);
    assert.notDeepEqual(dotted.outputs, nested.outputs);
    for (const output of [...dotted.outputs, ...nested.outputs]) {
      assert.equal(typeof await readFile(join(outDir, output), "utf8"), "string");
    }
  });
});

test("client-reference output collisions fail before publication", async () => {
  await withProject(async (project) => {
    const pageFile = join(project, "app/page.tsx");
    const outDir = join(project, "out");
    await mkdir(join(project, "app/a"), { recursive: true });
    await writeFile(
      join(project, "app/a.b.tsx"),
      `"use client"; export default function First() { return <button>first</button>; }\n`,
    );
    await writeFile(
      join(project, "app/a/b.tsx"),
      `"use client"; export default function Second() { return <button>second</button>; }\n`,
    );
    await writeFile(
      pageFile,
      [
        `import First from "./a.b";`,
        `import Second from "./a/b";`,
        `export default function Page() { return <main><First /><Second /></main>; }`,
        "",
      ].join("\n"),
    );

    await assert.rejects(
      build(project, pageFile, outDir, "/"),
      (error) => {
        assert.match(error.stderr, /client-reference output collision/);
        assert.match(error.stderr, /app\/a\.b\.tsx#default/);
        assert.match(error.stderr, /app\/a\/b\.tsx#default/);
        return true;
      },
    );
    assert.deepEqual(await readdir(outDir), []);
  });
});
