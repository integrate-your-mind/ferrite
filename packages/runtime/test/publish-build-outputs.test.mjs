import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBuildOutputs } from "../bin/publish-build-outputs.mjs";

test("publishBuildOutputs rolls back every output after a late publish failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-publish-rollback-"));
  try {
    await mkdir(join(root, "staging"));
    await mkdir(join(root, "final"));
    const stagingOutDir = await realpath(join(root, "staging"));
    const finalOutDir = await realpath(join(root, "final"));
    await writeFile(join(stagingOutDir, "first.js"), "new first\n");
    await writeFile(join(stagingOutDir, "second.js"), "new second\n");
    await writeFile(join(finalOutDir, "first.js"), "old first\n");
    await writeFile(join(finalOutDir, "second.js"), "old second\n");

    let renameCount = 0;
    const failFourthRenameOnce = async (source, destination) => {
      renameCount += 1;
      if (renameCount === 4) {
        throw Object.assign(new Error("injected late publication failure"), { code: "EIO" });
      }
      await rename(source, destination);
    };

    await assert.rejects(
      publishBuildOutputs(
        stagingOutDir,
        finalOutDir,
        ["first.js", "second.js"],
        { renameFile: failFourthRenameOnce },
      ),
      /injected late publication failure/,
    );

    assert.equal(renameCount, 6, "rollback must restore both backed-up destinations");
    assert.equal(await readFile(join(finalOutDir, "first.js"), "utf8"), "old first\n");
    assert.equal(await readFile(join(finalOutDir, "second.js"), "utf8"), "old second\n");
    assert.deepEqual((await readdir(finalOutDir)).sort(), ["first.js", "second.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
