import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { instantiateFerriteProtocolWasm } from "../packages/protocol-wasm/dist/index.js";
import { createCloudflareSsrHandler } from "../packages/runtime/dist/cloudflare.js";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderPageScript = join(workspaceRoot, "packages/runtime/bin/render-page.mjs");
const runtimePackage = join(workspaceRoot, "packages/runtime");
const ASSET_BUILD_ID = `sha256:${"a".repeat(64)}`;
const wasmPath = join(
  workspaceRoot,
  "packages/protocol-wasm/dist/ferrite_protocol_wasm.wasm",
);

test("executes a Ferrite route module and Rust HTML renderer at request time through Fetch", async () => {
  const project = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-ssr-"));
  try {
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    const scope = join(project, "node_modules/@ferrite");
    await mkdir(scope, { recursive: true });
    await symlink(runtimePackage, join(scope, "runtime"), platform === "win32" ? "junction" : "dir");

    const page = join(project, "app/page.tsx");
    const document = join(project, "app/document.tsx");
    const artifact = join(project, "server/route.mjs");
    await mkdir(dirname(page), { recursive: true });
    await writeFile(
      page,
      [
        "let renders = 0;",
        'export const metadata = { title: "Ferrite Edge" };',
        "export default function Page() {",
        "  renders += 1;",
        '  if (renders === 3) throw new Error("private route failure");',
        '  return <main data-render={renders}>Ferrite & Workers</main>;',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      document,
      [
        "export default function Document({ children, head }) {",
        "  return <html><head>{head}</head><body>{children}</body></html>;",
        "}",
        "",
      ].join("\n"),
    );
    await execFileAsync(
      "node",
      [
        renderPageScript,
        "--build-cloudflare-artifact",
        page,
        artifact,
        "[]",
        JSON.stringify(document),
        "{}",
        "/",
        JSON.stringify({
          assetBuildId: ASSET_BUILD_ID,
          fallbackPath: "/index.html",
          observedActions: [],
        }),
      ],
      { cwd: project, maxBuffer: 1024 * 1024 },
    );

    const receiptPath = `${artifact}.receipt.json`;
    const [routeModule, renderer, receiptBytes] = await Promise.all([
      import(`${pathToFileURL(artifact).href}?test=${Date.now()}`),
      instantiateFerriteProtocolWasm(await readFile(wasmPath)),
      readFile(receiptPath),
    ]);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const manifest = {
      format: { name: "ferrite-server", major: 1, minor: 0 },
      buildId: ASSET_BUILD_ID,
      routes: [{
        path: "/",
        prerendered: { "/": "index.html" },
        observedActions: [],
        cloudflare: {
          path: "/",
          sourceBuildId: receipt.sourceBuildId,
          metadataBuildId: receipt.metadataBuildId,
          moduleBuildId: receipt.moduleBuildId,
          moduleBytes: receipt.module.bytes,
          moduleSha256: receipt.module.sha256,
          receiptBytes: receiptBytes.byteLength,
          receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
        },
      }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const assetManifestSha256 =
      `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
    const fallbackRequests = [];
    const env = {
      ASSETS: {
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/ferrite-server.json") {
            return new Response(manifestBytes, {
              headers: { "Content-Type": "application/json" },
            });
          }
          fallbackRequests.push(pathname);
          return new Response("<!doctype html><p>prerender fallback</p>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },
      },
    };
    const handler = createCloudflareSsrHandler({
      routes: [{
        module: routeModule,
        document: { rootId: "edge-root" },
      }],
      renderer,
      assetManifestSha256,
    });

    const first = await handler.fetch(new Request("https://worker.example.test/"), env);
    const second = await handler.fetch(new Request("https://worker.example.test/"), env);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get("x-ferrite-render"), "request");
    assert.match(
      await first.text(),
      /^<!doctype html>\n<html><head><meta charset="utf-8"><title>Ferrite Edge<\/title><\/head><body><div data-ferrite-page-props="\{\}" data-route="\/" data-route-pattern="\/" id="edge-root"><main data-render="1">Ferrite &amp; Workers<\/main><\/div><\/body><\/html>$/,
    );
    assert.match(await second.text(), /data-render="2"/);
    assert.deepEqual(fallbackRequests, []);

    const failed = await handler.fetch(new Request("https://worker.example.test/"), env);
    assert.equal(failed.status, 200);
    assert.equal(failed.headers.get("x-ferrite-render"), "static-fallback");
    assert.equal(await failed.text(), "<!doctype html><p>prerender fallback</p>");
    assert.deepEqual(fallbackRequests, ["/index.html"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
