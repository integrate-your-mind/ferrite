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
  inventoryFiles,
  runCapture,
  startTrackedSourceMonitor,
  trackedSourceSnapshot,
} from "./verify-cloudflare-worker.mjs";

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
});

test("Cloudflare proof records and monitors tracked input bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-cloudflare-source-monitor-"));
  const monitor = startTrackedSourceMonitor(["source.mjs"], root);
  try {
    await writeFile(join(root, "source.mjs"), "export const value = 1;\n");
    const first = await trackedSourceSnapshot(["source.mjs"], root);
    assert.equal(first.trackedFileCount, 1);
    assert.match(first.trackedInputSha256, /^sha256:[a-f0-9]{64}$/);
    await writeFile(join(root, "source.mjs"), "export const value = 2;\n");
    const second = await trackedSourceSnapshot(["source.mjs"], root);
    assert.notEqual(second.trackedInputSha256, first.trackedInputSha256);
    await assert.rejects(
      monitor.assertUnchanged(),
      /tracked source changed during the Worker proof/,
    );
  } finally {
    monitor.close();
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
