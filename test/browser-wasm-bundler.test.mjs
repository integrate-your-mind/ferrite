import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildClientScript = join(repoRoot, "packages", "runtime", "bin", "build-client.mjs");

test("client bundler emits protocol WASM package assets", async () => {
  const project = await mkdtemp(join(tmpdir(), "ferrite-wasm-bundler-"));
  try {
    await writeFile(join(project, "package.json"), JSON.stringify({ type: "module" }));
    await mkdir(join(project, "app"), { recursive: true });
    await mkdir(join(project, "node_modules", "@ferrite"), { recursive: true });
    await symlink(
      join(repoRoot, "packages", "protocol-wasm"),
      join(project, "node_modules", "@ferrite", "protocol-wasm"),
      "dir",
    );
    const pageFile = join(project, "app", "page.tsx");
    const outDir = join(project, ".ferrite", "build", "_ferrite", "static");
    await writeFile(
      pageFile,
      [
        `"use client";`,
        `import wasmUrl from "@ferrite/protocol-wasm/ferrite_protocol_wasm.wasm";`,
        `import { instantiateFerriteProtocolWasm } from "@ferrite/protocol-wasm";`,
        ``,
        `export default function Page() {`,
        `  const label = typeof instantiateFerriteProtocolWasm === "function" ? wasmUrl : "missing";`,
        `  return <main data-wasm={label}>{label}</main>;`,
        `}`,
        ``,
      ].join("\n"),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [buildClientScript, pageFile, outDir, "/_ferrite/static", "/wasm"],
      { cwd: project },
    );
    const summary = JSON.parse(stdout.trim());

    assert.equal(summary.assets.length, 1);
    const wasmAsset = summary.assets[0];
    assert.match(wasmAsset, /^assets\/ferrite_protocol_wasm-[A-Z0-9]+\.wasm$/);
    assert(summary.outputs.includes(wasmAsset));
    const routeScript = summary.script.replace("/_ferrite/static/", "");
    const bundledJs = await readFile(join(outDir, routeScript), "utf8");
    assert.match(bundledJs, /instantiateFerriteProtocolWasm/);
    assert.match(
      bundledJs,
      /\/_ferrite\/static\/assets\/ferrite_protocol_wasm-[A-Z0-9]+\.wasm/,
    );
    await readFile(join(outDir, wasmAsset));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
