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

test("retains recovery backups when rollback fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-publish-rollback-retain-"));
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
    const failPublicationAndRollback = async (source, destination) => {
      renameCount += 1;
      if (renameCount === 4 || renameCount === 5) {
        throw Object.assign(new Error(`injected rename failure ${renameCount}`), { code: "EIO" });
      }
      await rename(source, destination);
    };

    await assert.rejects(
      publishBuildOutputs(
        stagingOutDir,
        finalOutDir,
        ["first.js", "second.js"],
        { renameFile: failPublicationAndRollback },
      ),
      (error) =>
        error instanceof AggregateError &&
        /recovery files preserved at .*\.ferrite-publish-/.test(error.message) &&
        error.errors.some((entry) => /injected rename failure 4/.test(entry.message)) &&
        error.errors.some((entry) => /injected rename failure 5/.test(entry.message)),
    );

    const publishRoots = (await readdir(finalOutDir)).filter((name) => name.startsWith(".ferrite-publish-"));
    assert.equal(publishRoots.length, 1, "incomplete rollback must retain its recovery directory");
    const recoveryRoot = join(finalOutDir, publishRoots[0]);
    assert.equal(await readFile(join(recoveryRoot, "1-second.js.previous"), "utf8"), "old second\n");
    assert.equal(await readFile(join(finalOutDir, "first.js"), "utf8"), "old first\n");
    assert.equal((await readdir(finalOutDir)).includes("second.js"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregates cleanup failure with the primary publication error and preserves scratch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-publish-cleanup-error-"));
  try {
    await mkdir(join(root, "staging"));
    await mkdir(join(root, "final"));
    const stagingOutDir = await realpath(join(root, "staging"));
    const finalOutDir = await realpath(join(root, "final"));
    let cleanupPath;

    await assert.rejects(
      publishBuildOutputs(
        stagingOutDir,
        finalOutDir,
        ["../escape.js"],
        {
          removeDirectory: async (path) => {
            cleanupPath = path;
            throw new Error("injected scratch cleanup failure");
          },
        },
      ),
      (error) =>
        error instanceof AggregateError &&
        /scratch preserved at .*\.ferrite-publish-/.test(error.message) &&
        error.errors.some((entry) => /escapes its build directory/.test(entry.message)) &&
        error.errors.some((entry) => /injected scratch cleanup failure/.test(entry.message)),
    );

    assert.ok(cleanupPath?.startsWith(join(finalOutDir, ".ferrite-publish-")));
    const publishRoots = (await readdir(finalOutDir)).filter((name) => name.startsWith(".ferrite-publish-"));
    assert.equal(publishRoots.length, 1, "failed cleanup must leave scratch available for recovery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes publication scratch after a successful publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-publish-success-"));
  try {
    await mkdir(join(root, "staging"));
    await mkdir(join(root, "final"));
    const stagingOutDir = await realpath(join(root, "staging"));
    const finalOutDir = await realpath(join(root, "final"));
    await writeFile(join(stagingOutDir, "client.js"), "new client\n");

    await publishBuildOutputs(stagingOutDir, finalOutDir, ["client.js"]);

    assert.equal(await readFile(join(finalOutDir, "client.js"), "utf8"), "new client\n");
    assert.deepEqual((await readdir(finalOutDir)).sort(), ["client.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
