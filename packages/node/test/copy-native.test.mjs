import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  copyNativeBinding,
  signDarwinNativeBinding,
} from "../scripts/copy-native.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ferrite-copy-native-"));
  const source = join(root, "target with spaces", "libferrite_node.dylib");
  const destination = join(root, "package with spaces", "ferrite-node.node");
  await mkdir(join(root, "target with spaces"), { recursive: true });
  await writeFile(source, "native-binding");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { destination, source };
}

test("copies non-macOS native bindings without invoking codesign", async (t) => {
  const { destination, source } = await fixture(t);
  let signCalls = 0;

  await copyNativeBinding({
    destination,
    source,
    platformName: "linux",
    signDarwinImpl: async () => {
      signCalls += 1;
    },
    logger: { log() {} },
  });

  assert.equal(await readFile(destination, "utf8"), "native-binding");
  assert.equal(signCalls, 0);
});

test("signs the copied macOS binding before reporting success", async (t) => {
  const { destination, source } = await fixture(t);
  const calls = [];

  const copiedPath = await copyNativeBinding({
    destination,
    source,
    platformName: "darwin",
    signDarwinImpl: async (path) => {
      calls.push({ bytes: await readFile(path, "utf8"), path });
    },
    logger: { log() {} },
  });

  assert.equal(copiedPath, destination);
  assert.deepEqual(calls, [{ bytes: "native-binding", path: destination }]);
});

test("removes a copied macOS binding when codesign fails", async (t) => {
  const { destination, source } = await fixture(t);

  await assert.rejects(
    copyNativeBinding({
      destination,
      source,
      platformName: "darwin",
      signDarwinImpl: async () => {
        throw new Error("injected signing failure");
      },
      logger: { log() {} },
    }),
    /could not ad-hoc sign.*injected signing failure/,
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "native-binding");
});

test("invokes the absolute codesign binary without a timestamp or shell", async () => {
  const calls = [];

  await signDarwinNativeBinding("/tmp/ferrite node.node", {
    execFileImpl: async (...args) => {
      calls.push(args);
    },
  });

  assert.deepEqual(calls, [
    [
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--timestamp=none", "/tmp/ferrite node.node"],
      { encoding: "utf8" },
    ],
  ]);
});
