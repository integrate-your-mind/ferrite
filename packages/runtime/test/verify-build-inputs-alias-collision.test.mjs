import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const verifier = join(workspaceRoot, "packages/runtime/bin/verify-build-inputs.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");

async function runVerifier(project, pageFile) {
  const request = {
    project,
    documentFile: null,
    routes: [{ pageFile, layouts: [], loadingFile: null, errorFile: null }],
  };
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [verifier], {
      cwd: project,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const error = new Error(`build input verifier failed with ${code ?? signal}`);
      error.stdout = stdout;
      error.stderr = stderr;
      rejectRun(error);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

test("installed package name collisions do not bypass project alias rejection", async () => {
  const project = await mkdtemp(join(tmpdir(), "ferrite-alias-collision-"));
  try {
    const pageFile = join(project, "app/page.tsx");
    const aliasTarget = join(project, "app/ui/Client.tsx");
    const installedPackage = join(project, "packages/installed-ui-client");
    await mkdir(dirname(aliasTarget), { recursive: true });
    await mkdir(installedPackage, { recursive: true });
    await mkdir(join(project, "node_modules/@ferrite"), { recursive: true });
    await mkdir(join(project, "node_modules/@ui"), { recursive: true });
    await symlink(runtimePackage, join(project, "node_modules/@ferrite/runtime"), platform === "win32" ? "junction" : "dir");
    await symlink(installedPackage, join(project, "node_modules/@ui/Client"), platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2),
    );
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            jsx: "react-jsx",
            jsxImportSource: "@ferrite/runtime",
            module: "ESNext",
            moduleResolution: "Bundler",
            paths: { "@ui/Client": ["app/ui/Client.tsx"] },
            target: "ES2022",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(installedPackage, "package.json"),
      JSON.stringify({ name: "@ui/Client", type: "module", exports: "./index.js" }, null, 2),
    );
    await writeFile(join(installedPackage, "index.js"), `export default function Installed() { return null; }\n`);
    await writeFile(
      aliasTarget,
      `"use client"; export default function Aliased() { return <button>Alias</button>; }\n`,
    );
    await writeFile(
      pageFile,
      `import Client from "@ui/Client"; export default function Page() { return <Client />; }\n`,
    );

    await assert.rejects(
      runVerifier(project, pageFile),
      (error) => {
        assert.match(error.stderr, /project-local non-relative import "@ui\/Client"/);
        assert.match(error.stderr, /app\/ui\/Client\.tsx/);
        return true;
      },
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
