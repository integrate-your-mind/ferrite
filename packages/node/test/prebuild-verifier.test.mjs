import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPrebuildPackage } from "../scripts/create-prebuild-package.mjs";
import { verifyPrebuildPackageDirs } from "../scripts/verify-prebuild-package.mjs";

const nodePackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

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

test("generated prebuilds inherit public repository metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
  const destination = join(root, "candidate");
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "ferrite-node.node"), "native binding");
    await writeFile(join(root, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`);

    const result = await createPrebuildPackage({
      packageRoot: root,
      destinationRoot: destination,
      platform: "darwin",
      arch: "arm64",
    });
    const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));

    assert.equal(result.packageName, "@ferrite/node-darwin-arm64");
    assert.deepEqual(manifest.repository, nodePackage.repository);
    assert.equal(manifest.homepage, nodePackage.homepage);
    assert.deepEqual(manifest.bugs, nodePackage.bugs);
    assert.deepEqual(manifest.engines, nodePackage.engines);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("rejects native packages without public publish metadata", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      publishConfig: {},
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /publishConfig\.access must be public/,
    );
  });
});

test("rejects native package licenses that do not match @ferrite/node", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      license: `${nodePackage.license}-mismatch`,
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /package license must match @ferrite\/node/,
    );
  });
});

test("rejects native package repository metadata that does not match @ferrite/node", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      repository: { type: "git", url: "https://example.invalid/ferrite.git" },
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /package repository must match @ferrite\/node/,
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

async function writePrebuildPackage(
  dir,
  {
    packageName,
    os,
    cpu,
    binding,
    sha256,
    license = nodePackage.license,
    repository = nodePackage.repository,
    homepage = nodePackage.homepage,
    bugs = nodePackage.bugs,
    engines = nodePackage.engines,
    publishConfig = { access: "public" },
  },
) {
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
        description: `Ferrite native Node.js binding for ${os}/${cpu}.`,
        license,
        keywords: ["ferrite", "node-api", "native", "ssr", "rust"],
        repository,
        homepage,
        bugs,
        engines,
        publishConfig,
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
