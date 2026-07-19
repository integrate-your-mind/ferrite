import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertBuildClientImportContract } from "../bin/build-client-import-guard.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const projectPathModule = join(workspaceRoot, "packages/runtime/bin/project-path.mjs");

async function withProject(config, run) {
  const project = await mkdtemp(join(tmpdir(), "ferrite-import-guard-"));
  try {
    await mkdir(join(project, "app"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify(config.packageJson ?? { private: true, type: "module" }, null, 2),
    );
    if (config.tsconfig) {
      await writeFile(join(project, "tsconfig.json"), JSON.stringify(config.tsconfig, null, 2));
    }
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

function buildClientArgs(pageFile) {
  return [pageFile, "out", "/_ferrite/static", "/", "{}", "[]", "{}"];
}

function runNode(script, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

test("build-client guard rejects path aliases even when an installed package has the same name", async () => {
  await withProject(
    {
      tsconfig: {
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@ui/Client": ["app/ui/Client.tsx"] },
        },
      },
    },
    async (project) => {
      await mkdir(join(project, "app/ui"), { recursive: true });
      await mkdir(join(project, "node_modules/@ui/Client"), { recursive: true });
      await writeFile(
        join(project, "node_modules/@ui/Client/package.json"),
        JSON.stringify({ name: "@ui/Client", exports: "./index.js" }),
      );
      await writeFile(join(project, "node_modules/@ui/Client/index.js"), "export default 1;\n");
      await writeFile(
        join(project, "app/ui/Client.tsx"),
        `"use client"; export default function Client() { return null; }\n`,
      );
      const pageFile = join(project, "app/page.tsx");
      await writeFile(
        pageFile,
        `import Client from "@ui/Client"; export default function Page() { return <Client />; }\n`,
      );

      await assert.rejects(
        assertBuildClientImportContract(buildClientArgs(pageFile)),
        /project-local non-relative import "@ui\/Client".*app\/ui\/Client\.tsx/,
      );
    },
  );
});

test("build-client guard rejects package imports that resolve to project source", async () => {
  await withProject(
    {
      packageJson: {
        private: true,
        type: "module",
        imports: { "#client": "./app/Client.tsx" },
      },
      tsconfig: {
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      },
    },
    async (project) => {
      await writeFile(
        join(project, "app/Client.tsx"),
        `"use client"; export default function Client() { return null; }\n`,
      );
      const pageFile = join(project, "app/page.tsx");
      await writeFile(
        pageFile,
        `import Client from "#client"; export default function Page() { return <Client />; }\n`,
      );

      await assert.rejects(
        assertBuildClientImportContract(buildClientArgs(pageFile)),
        /project-local non-relative import "#client"/,
      );
    },
  );
});

test("build-client guard checks aliases reached through relative dependencies", async () => {
  await withProject(
    {
      tsconfig: {
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@app/*": ["app/*"] },
        },
      },
    },
    async (project) => {
      await writeFile(
        join(project, "app/Client.tsx"),
        `"use client"; export default function Client() { return null; }\n`,
      );
      await writeFile(
        join(project, "app/helper.ts"),
        `import Client from "@app/Client"; export { Client };\n`,
      );
      const pageFile = join(project, "app/page.tsx");
      await writeFile(
        pageFile,
        `import { Client } from "./helper"; export default function Page() { return <Client />; }\n`,
      );

      await assert.rejects(
        assertBuildClientImportContract(buildClientArgs(pageFile)),
        /project-local non-relative import "@app\/Client"/,
      );
    },
  );
});

test("build-client guard ignores erased type-only aliases and unresolved external packages", async () => {
  await withProject(
    {
      tsconfig: {
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@app/*": ["app/*"] },
        },
      },
    },
    async (project) => {
      await writeFile(join(project, "app/types.d.ts"), "export type Props = {};\n");
      const pageFile = join(project, "app/page.tsx");
      await writeFile(
        pageFile,
        `import { type Props } from "@app/types"; import value from "external-package"; export default function Page(_props: Props) { return value; }\n`,
      );

      await assert.doesNotReject(assertBuildClientImportContract(buildClientArgs(pageFile)));
    },
  );
});

test("project-path runs the guard before build-client continues", async () => {
  await withProject(
    {
      tsconfig: {
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@app/*": ["app/*"] },
        },
      },
    },
    async (project) => {
      await writeFile(
        join(project, "app/Client.tsx"),
        `"use client"; export default function Client() { return null; }\n`,
      );
      const pageFile = join(project, "app/page.tsx");
      await writeFile(
        pageFile,
        `import Client from "@app/Client"; export default function Page() { return <Client />; }\n`,
      );
      const script = join(project, "build-client.mjs");
      await writeFile(
        script,
        `import ${JSON.stringify(pathToFileURL(projectPathModule).href)}; process.stdout.write("continued");\n`,
      );

      const result = await runNode(script, buildClientArgs(pageFile), project);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /project-local non-relative import "@app\/Client"/);
    },
  );
});
