import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPrebuildPackageDirs } from "../scripts/verify-prebuild-package.mjs";

test("verifies a valid generated prebuild package", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
    });

    assert.deepEqual(await verifyPrebuildPackageDirs([dir]), [
      {
        packageName: "@ferrite/node-darwin-arm64",
        directory: dir,
      },
    ]);
  });
});

test("rejects checksum mismatches", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      sha256: "0".repeat(64),
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /checksum mismatch/,
    );
  });
});

test("rejects package os and cpu that do not match the target mapping", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-linux-x64-gnu",
      os: "darwin",
      cpu: "x64",
      binding: Buffer.from("native binding"),
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /must declare os linux/,
    );
  });
});

test("rejects missing expected aggregate packages", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
    });

    await assert.rejects(
      () =>
        verifyPrebuildPackageDirs([dir], {
          expectedPackages: [
            "@ferrite/node-darwin-arm64",
            "@ferrite/node-linux-x64-gnu",
          ],
        }),
      /missing expected prebuild packages: @ferrite\/node-linux-x64-gnu/,
    );
  });
});

async function withPackageFixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), "ferrite-prebuild-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePrebuildPackage(dir, { packageName, os, cpu, binding, sha256 }) {
  const digest = sha256 ?? createHash("sha256").update(binding).digest("hex");
  await writeFile(join(dir, "ferrite-node.node"), binding);
  await writeFile(
    join(dir, "ferrite-node.sha256.json"),
    `${JSON.stringify(
      {
        file: "ferrite-node.node",
        algorithm: "sha256",
        sha256: digest,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        os: [os],
        cpu: [cpu],
        files: ["ferrite-node.node", "ferrite-node.sha256.json"],
        exports: {
          "./ferrite-node.node": "./ferrite-node.node",
          "./ferrite-node.sha256.json": "./ferrite-node.sha256.json",
        },
      },
      null,
      2,
    )}\n`,
  );
}
