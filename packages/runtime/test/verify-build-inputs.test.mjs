import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const verifier = join(workspaceRoot, "packages/runtime/bin/verify-build-inputs.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");

async function withTempProject(run) {
  const project = await mkdtemp(join(tmpdir(), "ferrite-build-inputs-"));
  try {
    await mkdir(join(project, "app"), { recursive: true });
    await mkdir(join(project, "node_modules/@ferrite"), { recursive: true });
    await symlink(runtimePackage, join(project, "node_modules/@ferrite/runtime"), platform === "win32" ? "junction" : "dir");
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2),
    );
    await writeFile(
      join(project, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            jsx: "react-jsx",
            jsxImportSource: "@ferrite/runtime",
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
          },
        },
        null,
        2,
      ),
    );
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function runVerifier(project) {
  const pageFile = join(project, "app/page.tsx");
  const request = {
    project,
    documentFile: null,
    routes: [
      {
        pageFile,
        layouts: [],
        loadingFile: null,
        errorFile: null,
      },
    ],
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
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      rejectRun(error);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

test("build input verifier records server-only JSON inputs", async () => {
  await withTempProject(async (project) => {
    const pageFile = join(project, "app/page.tsx");
    const dataFile = join(project, "app/data.json");
    await writeFile(dataFile, '{"title":"first"}\n');
    await writeFile(
      pageFile,
      `import data from "./data.json"; export default function Page() { return <main>{data.title}</main>; }\n`,
    );

    const first = JSON.parse((await runVerifier(project)).stdout);
    const canonicalData = await realpath(dataFile);
    const firstData = first.inputs.find((input) => input.path === canonicalData);
    assert.match(firstData?.value ?? "", /^sha256:[a-f0-9]{64}$/);

    await writeFile(dataFile, '{"title":"second"}\n');
    const second = JSON.parse((await runVerifier(project)).stdout);
    const secondData = second.inputs.find((input) => input.path === canonicalData);
    assert.notEqual(secondData?.value, firstData?.value);
  });
});

test("build input verifier accepts relative project imports", async () => {
  await withTempProject(async (project) => {
    await writeFile(
      join(project, "app/Client.tsx"),
      `"use client"; export default function Client() { return <button>Client</button>; }\n`,
    );
    await writeFile(
      join(project, "app/page.tsx"),
      `import Client from "./Client"; export default function Page() { return <Client />; }\n`,
    );

    const response = JSON.parse((await runVerifier(project)).stdout);
    assert.ok(response.inputs.some((input) => input.path.endsWith("/app/Client.tsx")));
  });
});

test("build input verifier rejects project-local TypeScript path aliases", async () => {
  await withTempProject(async (project) => {
    const tsconfig = JSON.parse(await readFile(join(project, "tsconfig.json"), "utf8"));
    tsconfig.compilerOptions.baseUrl = ".";
    tsconfig.compilerOptions.paths = { "@ui/*": ["app/ui/*"] };
    await writeFile(join(project, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    await mkdir(join(project, "app/ui"), { recursive: true });
    await writeFile(
      join(project, "app/ui/Client.tsx"),
      `"use client"; export default function Client() { return <button>Client</button>; }\n`,
    );
    await writeFile(
      join(project, "app/page.tsx"),
      `import Client from "@ui/Client"; export default function Page() { return <Client />; }\n`,
    );

    await assert.rejects(
      runVerifier(project),
      (error) => {
        assert.match(error.stderr, /project-local non-relative import "@ui\/Client"/);
        assert.match(error.stderr, /app\/page\.tsx/);
        assert.match(error.stderr, /app\/ui\/Client\.tsx/);
        return true;
      },
    );
  });
});
