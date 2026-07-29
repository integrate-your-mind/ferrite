import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";

import {
  assertCleanSourceState,
  assertInventoriedRegularFile,
  assertSameSourceState,
  assertSupportedIndexFlag,
  gitBlobObjectId,
  inventoryFiles,
  isExpectedRequestedTermination,
  removeWranglerDryRunReadme,
  runCapture,
  startTrackedSourceMonitor,
  trackedSourceSnapshot,
} from "./verify-cloudflare-worker.mjs";

test("Cloudflare proof accepts exit 143 only after requested SIGTERM", () => {
  assert.equal(
    isExpectedRequestedTermination({ code: 143, signal: null }, true),
    true,
  );
  assert.equal(
    isExpectedRequestedTermination({ code: 143, signal: null }, false),
    false,
  );
  assert.equal(
    isExpectedRequestedTermination({ code: null, signal: "SIGTERM" }, true),
    true,
  );
  assert.equal(
    isExpectedRequestedTermination({ code: 1, signal: null }, true),
    false,
  );
});

test("Cloudflare proof excludes only validated Wrangler dry-run metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-wrangler-metadata-"));
  try {
    const output = join(root, "bundle");
    const readme = join(output, "README.md");
    const worker = "ferrite-worker";
    await mkdir(output);
    await writeFile(
      readme,
      `This folder contains the built output assets for the worker "${worker}" generated at 2026-07-29T19:00:00.000Z.`,
    );
    assert.deepEqual(await removeWranglerDryRunReadme(output, worker), {
      path: "README.md",
      bytes: 115,
      generatedAt: "2026-07-29T19:00:00.000Z",
      worker,
      removed: true,
    });
    await assert.rejects(readFile(readme), (error) => error?.code === "ENOENT");

    await writeFile(readme, "unexpected metadata");
    await assert.rejects(
      removeWranglerDryRunReadme(output, worker),
      /did not match the expected metadata format/,
    );

    await rm(readme);
    const external = join(root, "external-readme");
    await writeFile(
      external,
      `This folder contains the built output assets for the worker "${worker}" generated at 2026-07-29T19:00:00.000Z.`,
    );
    await symlink(external, readme);
    await assert.rejects(
      removeWranglerDryRunReadme(output, worker),
      /must be a regular, non-symlink file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare proof inventory binds regular files to their exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-inventory-"));
  try {
    const bundle = join(root, "bundle");
    const entry = join(bundle, "worker.mjs");
    await mkdir(bundle);
    await writeFile(entry, "export default {};\n");

    const inventory = await inventoryFiles(bundle);
    assert.deepEqual(inventory.files, [{
      path: "worker.mjs",
      bytes: 19,
      sha256: "450f0af4f4c1ecc4c7180f2e364c8a59bfed69dd350fb6b47bce8641c2a37786",
    }]);
    assert.equal(
      await assertInventoriedRegularFile(bundle, entry, inventory),
      await realpath(entry),
    );

    await writeFile(entry, "export default { changed: true };\n");
    await assert.rejects(
      assertInventoriedRegularFile(bundle, entry, inventory),
      /changed after the exact bundle inventory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare proof inventory rejects symlinks and symlink replacement", { skip: platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-inventory-"));
  try {
    const bundle = join(root, "bundle");
    const entry = join(bundle, "worker.mjs");
    const external = join(root, "external.mjs");
    await mkdir(bundle);
    await writeFile(external, "export default { external: true };\n");
    await symlink(external, entry);

    await assert.rejects(
      inventoryFiles(bundle),
      /rejects non-regular entry "worker\.mjs"/,
    );

    await rm(entry);
    await writeFile(entry, "export default {};\n");
    const inventory = await inventoryFiles(bundle);
    await rm(entry);
    await symlink(external, entry);
    await assert.rejects(
      assertInventoriedRegularFile(bundle, entry, inventory),
      /must be a regular, non-symlink file/,
    );

    await rm(entry);
    const nested = join(bundle, "nested");
    const nestedEntry = join(nested, "worker.mjs");
    await mkdir(nested);
    await writeFile(nestedEntry, "export default {};\n");
    const nestedInventory = await inventoryFiles(bundle);
    const externalDirectory = join(root, "external");
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, "worker.mjs"), "export default {};\n");
    await rm(nested, { recursive: true });
    await symlink(externalDirectory, nested);
    await assert.rejects(
      assertInventoriedRegularFile(bundle, nestedEntry, nestedInventory),
      /must not traverse an intermediate symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare proof rejects dirty or changing source state", () => {
  const source = {
    branch: "codex/cloudflare-request-ssr",
    clean: true,
    committedSourceSha256: `sha256:${"f".repeat(64)}`,
    head: "a".repeat(40),
    residue: null,
    trackedFileCount: 10,
    trackedInputSha256: `sha256:${"d".repeat(64)}`,
    tree: "b".repeat(40),
  };
  assert.doesNotThrow(() => assertCleanSourceState(source, "before the proof"));
  assert.doesNotThrow(() => assertSameSourceState(source, { ...source }));
  assert.throws(
    () => assertCleanSourceState({ ...source, clean: false, residue: " M route.ts" }, "before the proof"),
    /requires a clean source tree before the proof/,
  );
  assert.throws(
    () => assertSameSourceState(source, { ...source, tree: "c".repeat(40) }),
    /tracked-input identity changed/,
  );
  assert.throws(
    () => assertSameSourceState(source, {
      ...source,
      trackedInputSha256: `sha256:${"e".repeat(64)}`,
    }),
    /tracked-input identity changed/,
  );
  assert.doesNotThrow(() => assertSupportedIndexFlag("source.mjs", "H"));
  assert.throws(
    () => assertSupportedIndexFlag("source.mjs", "h"),
    /assume-unchanged, skip-worktree/,
  );
  assert.throws(
    () => assertSupportedIndexFlag("source.mjs", "S"),
    /assume-unchanged, skip-worktree/,
  );
});

test("Cloudflare proof records and monitors tracked input bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-source-monitor-"));
  let monitor;
  try {
    const original = Buffer.from("export const value = 1;\n");
    const contract = {
      committedSourceSha256: `sha256:${"a".repeat(64)}`,
      objectFormat: "sha1",
      records: [{
        path: "source.mjs",
        mode: "100644",
        oid: gitBlobObjectId(original, "sha1"),
      }],
    };
    await writeFile(join(root, "source.mjs"), original);
    const first = await trackedSourceSnapshot(contract, root);
    assert.equal(first.trackedFileCount, 1);
    assert.match(first.trackedInputSha256, /^sha256:[a-f0-9]{64}$/);
    monitor = await startTrackedSourceMonitor(["source.mjs"], root);
    await writeFile(join(root, "source.mjs"), "export const value = 2;\n");
    await assert.rejects(
      trackedSourceSnapshot(contract, root),
      /bytes differ from HEAD/,
    );
    await writeFile(join(root, "source.mjs"), original);
    assert.deepEqual(await trackedSourceSnapshot(contract, root), first);
    await assert.rejects(
      monitor.assertUnchanged(),
      /tracked source changed during the Worker proof/,
    );
  } finally {
    monitor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare source monitor rejects a transient untracked Cargo build script", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-source-monitor-"));
  let monitor;
  try {
    const crate = join(root, "crates/ferrite-protocol-wasm");
    await mkdir(crate, { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(crate, "Cargo.toml"), "[package]\nname = \"fixture\"\n");
    monitor = await startTrackedSourceMonitor(
      ["package.json", "crates/ferrite-protocol-wasm/Cargo.toml"],
      root,
      {
        allowedWritePrefixes: ["target"],
        rejectUnexpectedPaths: true,
      },
    );

    await mkdir(join(root, "target"));
    await writeFile(join(root, "target/output"), "owned build output\n");
    await monitor.assertUnchanged();

    const buildScript = join(crate, "build.rs");
    await writeFile(buildScript, "fn main() { println!(\"cargo:rustc-cfg=forged\"); }\n");
    await rm(buildScript);
    await monitor.assertUnchanged().then(
      () => assert.fail("transient untracked build.rs was not observed"),
      (error) => assert.match(
        error.message,
        /tracked source changed during the Worker proof: .*build\.rs/,
      ),
    );
  } finally {
    monitor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare fixture and bundle monitors reject restored ABA replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-aba-"));
  const fixture = join(root, "fixture");
  const bundle = join(root, "bundle");
  let fixtureMonitor;
  let bundleMonitor;
  try {
    await Promise.all([mkdir(fixture), mkdir(bundle)]);
    await writeFile(join(fixture, "route.mjs"), "export const route = 1;\n");
    await writeFile(join(bundle, "worker.mjs"), "export default { fetch() {} };\n");
    const fixtureBefore = await inventoryFiles(fixture);
    const bundleBefore = await inventoryFiles(bundle);
    fixtureMonitor = await startTrackedSourceMonitor(
      fixtureBefore.files.map(({ path }) => path),
      fixture,
    );
    bundleMonitor = await startTrackedSourceMonitor(
      bundleBefore.files.map(({ path }) => path),
      bundle,
    );

    await writeFile(join(fixture, "route.mjs"), "export const route = 2;\n");
    await writeFile(join(fixture, "route.mjs"), "export const route = 1;\n");
    await writeFile(join(bundle, "worker.mjs"), "export default { altered: true };\n");
    await writeFile(join(bundle, "worker.mjs"), "export default { fetch() {} };\n");

    assert.deepEqual(await inventoryFiles(fixture), fixtureBefore);
    assert.deepEqual(await inventoryFiles(bundle), bundleBefore);
    await assert.rejects(fixtureMonitor.assertUnchanged(), /tracked source changed/);
    await assert.rejects(bundleMonitor.assertUnchanged(), /tracked source changed/);
  } finally {
    fixtureMonitor?.close();
    bundleMonitor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("captured command timeout terminates the complete process group", { skip: platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-process-tree-"));
  try {
    const grandchild = join(root, "grandchild.mjs");
    const parent = join(root, "parent.mjs");
    const pidFile = join(root, "grandchild.pid");
    await writeFile(grandchild, "setInterval(() => {}, 1_000);\n");
    await writeFile(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const child = spawn(process.execPath, [process.argv[2]], { stdio: \"ignore\" });",
        "writeFileSync(process.argv[3], String(child.pid));",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    );

    await assert.rejects(
      runCapture(
        process.execPath,
        [parent, grandchild, pidFile],
        { cwd: root, timeoutMs: 1_000 },
      ),
      /exceeded 1000ms/,
    );
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(
      () => process.kill(grandchildPid, 0),
      (error) => error?.code === "ESRCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured command rejects and terminates descendants left after normal exit", { skip: platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-process-tree-"));
  try {
    const grandchild = join(root, "grandchild.mjs");
    const parent = join(root, "parent.mjs");
    const pidFile = join(root, "grandchild.pid");
    await writeFile(grandchild, "setInterval(() => {}, 1_000);\n");
    await writeFile(
      parent,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const child = spawn(process.execPath, [process.argv[2]], { stdio: \"ignore\" });",
        "writeFileSync(process.argv[3], String(child.pid));",
        "child.unref();",
        "",
      ].join("\n"),
    );

    await assert.rejects(
      runCapture(
        process.execPath,
        [parent, grandchild, pidFile],
        { cwd: root, timeoutMs: 5_000 },
      ),
      /left 1 descendant process/,
    );
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(
      () => process.kill(grandchildPid, 0),
      (error) => error?.code === "ESRCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
