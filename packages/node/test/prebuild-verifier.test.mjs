import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    assert.deepEqual(await verifyPrebuildPackageDirs([destination]), [
      {
        packageName: "@ferrite/node-darwin-arm64",
        directory: destination,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal((await stat(destination)).mode & 0o777, 0o700);
      assert.equal((await stat(join(destination, "ferrite-node.node"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(destination, "ferrite-node.sha256.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(destination, "package.json"))).mode & 0o777, 0o600);
    }
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

test("rejects a symlinked prebuild root and artifact instead of following it", async () => {
  await withPackageFixture(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), "ferrite-prebuild-outside-"));
    try {
      await writePrebuildPackage(outside, {
        packageName: "@ferrite/node-darwin-arm64",
        os: "darwin",
        cpu: "arm64",
        binding: Buffer.from("outside binding"),
      });
      await symlink(outside, join(dir, "root-link"));
      await assert.rejects(
        () => verifyPrebuildPackageDirs([join(dir, "root-link")]),
        /must not be a symlink or reparse point/,
      );

      await writePrebuildPackage(dir, {
        packageName: "@ferrite/node-darwin-arm64",
        os: "darwin",
        cpu: "arm64",
        binding: Buffer.from("inside binding"),
      });
      await rm(join(dir, "ferrite-node.node"));
      await symlink(join(outside, "ferrite-node.node"), join(dir, "ferrite-node.node"));
      await assert.rejects(
        () => verifyPrebuildPackageDirs([dir]),
        /native binding must not be a symlink or reparse point/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("cleans a failed private staging write and preserves the prior complete output", async () => {
  await withPackageFixture(async (dir) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
    const destination = join(dir, "candidate");
    try {
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "new binding");
      await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`);
      await mkdir(destination, { recursive: true });
      await writePrebuildPackage(destination, {
        packageName: "@ferrite/node-darwin-arm64",
        os: "darwin",
        cpu: "arm64",
        binding: Buffer.from("prior binding"),
      });
      let writes = 0;
      await assert.rejects(
        () =>
          createPrebuildPackage({
            packageRoot: sourceRoot,
            destinationRoot: destination,
            platform: "darwin",
            arch: "arm64",
            writeFileImpl: async (...args) => {
              writes += 1;
              if (writes === 2) throw new Error("injected partial write failure");
              return writeFile(...args);
            },
          }),
        /injected partial write failure/,
      );
      assert.equal(await readFile(join(destination, "ferrite-node.node"), "utf8"), "prior binding");
      const siblings = await readdir(dir);
      assert.equal(siblings.some((name) => name.includes(".candidate.staging-")), false);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("rejects extra staging files and byte-mutated generated manifests", async () => {
  for (const mutation of ["extra-file", "manifest-bytes"]) {
    await withPackageFixture(async (dir) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
      const destination = join(dir, "candidate");
      try {
        await mkdir(join(sourceRoot, "dist"), { recursive: true });
        await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "new binding");
        await writeFile(
          join(sourceRoot, "package.json"),
          `${JSON.stringify(nodePackage, null, 2)}\n`,
        );
        let writes = 0;
        await assert.rejects(
          () =>
            createPrebuildPackage({
              packageRoot: sourceRoot,
              destinationRoot: destination,
              platform: "darwin",
              arch: "arm64",
              writeFileImpl: async (...args) => {
                await writeFile(...args);
                writes += 1;
                if (writes === 3 && mutation === "extra-file") {
                  await writeFile(join(dirname(args[0]), "unexpected.txt"), "unexpected");
                }
                if (writes === 3 && mutation === "manifest-bytes") {
                  await writeFile(args[0], "{}\n");
                }
              },
            }),
          mutation === "extra-file"
            ? /must contain exactly/
            : /artifact set did not verify byte-for-byte/,
        );
        await assert.rejects(readFile(destination), /ENOENT/);
        const siblings = await readdir(dir);
        assert.equal(siblings.some((name) => name.includes(".candidate.staging-")), false);
      } finally {
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  }
});

test("reports both creation and staging-cleanup failures", async () => {
  await withPackageFixture(async (dir) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
    try {
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "new binding");
      await writeFile(
        join(sourceRoot, "package.json"),
        `${JSON.stringify(nodePackage, null, 2)}\n`,
      );
      let writes = 0;
      await assert.rejects(
        () =>
          createPrebuildPackage({
            packageRoot: sourceRoot,
            destinationRoot: join(dir, "candidate"),
            platform: "darwin",
            arch: "arm64",
            writeFileImpl: async (...args) => {
              writes += 1;
              if (writes === 2) throw new Error("injected creation failure");
              return writeFile(...args);
            },
            removeImpl: async () => {
              throw new Error("injected cleanup failure");
            },
          }),
        (error) =>
          error instanceof AggregateError &&
          /creation failed and private staging cleanup also failed/.test(error.message) &&
          error.errors.some((cause) => /creation failure/.test(cause.message)) &&
          error.errors.some((cause) => /cleanup failure/.test(cause.message)),
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("rolls back the prior output when atomic publication fails", async () => {
  await withPackageFixture(async (dir) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
    const destination = join(dir, "candidate");
    try {
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "new binding");
      await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`);
      await mkdir(destination, { recursive: true });
      await writePrebuildPackage(destination, {
        packageName: "@ferrite/node-darwin-arm64",
        os: "darwin",
        cpu: "arm64",
        binding: Buffer.from("prior binding"),
      });
      let renames = 0;
      await assert.rejects(
        () =>
          createPrebuildPackage({
            packageRoot: sourceRoot,
            destinationRoot: destination,
            platform: "darwin",
            arch: "arm64",
            renameImpl: async (...args) => {
              renames += 1;
              if (renames === 2) throw new Error("injected publication failure");
              return rename(...args);
            },
          }),
        /injected publication failure/,
      );
      assert.equal(await readFile(join(destination, "ferrite-node.node"), "utf8"), "prior binding");
      const siblings = await readdir(dir);
      assert.equal(siblings.some((name) => name.includes(".candidate.staging-")), false);
      assert.equal(siblings.some((name) => name.includes(".backup")), false);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("reports the preserved backup when rollback itself fails", async () => {
  await withPackageFixture(async (dir) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
    const destination = join(dir, "candidate");
    try {
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "new binding");
      await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`);
      await mkdir(destination, { recursive: true });
      await writePrebuildPackage(destination, {
        packageName: "@ferrite/node-darwin-arm64",
        os: "darwin",
        cpu: "arm64",
        binding: Buffer.from("prior binding"),
      });
      let renames = 0;
      await assert.rejects(
        () =>
          createPrebuildPackage({
            packageRoot: sourceRoot,
            destinationRoot: destination,
            platform: "darwin",
            arch: "arm64",
            renameImpl: async (...args) => {
              renames += 1;
              if (renames === 2 || renames === 3) throw new Error(`injected rename failure ${renames}`);
              return rename(...args);
            },
          }),
        (error) =>
          error instanceof AggregateError &&
          /rollback also failed/.test(error.message) &&
          /preserved at .*\.backup/.test(error.message),
      );
      const siblings = await readdir(dir);
      assert.equal(siblings.some((name) => name.includes(".candidate.staging-")), false);
      assert.equal(siblings.some((name) => name.includes(".backup")), true);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

test("rejects a deterministic source substitution between path checks and open", async () => {
  await withPackageFixture(async (dir) => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "ferrite-prebuild-source-"));
    const outside = join(dir, "attacker.node");
    try {
      await mkdir(join(sourceRoot, "dist"), { recursive: true });
      await writeFile(join(sourceRoot, "dist", "ferrite-node.node"), "original binding");
      await writeFile(join(sourceRoot, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`);
      await writeFile(outside, "substituted binding");
      let opens = 0;
      await assert.rejects(
        () =>
          createPrebuildPackage({
            packageRoot: sourceRoot,
            destinationRoot: join(dir, "candidate"),
            platform: "darwin",
            arch: "arm64",
            openImpl: async (path, flags) => {
              opens += 1;
              if (opens === 2) {
                await rm(join(sourceRoot, "dist", "ferrite-node.node"));
                await symlink(outside, join(sourceRoot, "dist", "ferrite-node.node"));
              }
              return open(path, flags);
            },
          }),
        /ELOOP|too many symbolic links|no-follow/i,
      );
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
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
        version: nodePackage.version,
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
