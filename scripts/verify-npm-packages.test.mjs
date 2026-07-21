import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_PACKAGE_NAMES,
  createReleaseManifest,
  validateManifestMetadata,
  validatePackFiles,
  validatePackedManifest,
  verifyCleanDeveloperWorkflow,
  verifyNpmPackages,
} from "./verify-npm-packages.mjs";

test("clean developer workflow rejects a missing artifact before building and then serves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-clean-workflow-"));
  const cliSource = join(root, "source-ferrite");
  const calls = [];
  try {
    await writeFile(cliSource, "candidate cli");
    await verifyCleanDeveloperWorkflow(root, {
      cliSource,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (args[0] === "serve" && calls.filter((call) => call.args[0] === "serve").length === 1) {
          throw new Error(
            "artifact directory /tmp/starter/.ferrite/build is unavailable: No such file or directory (os error 2)",
          );
        }
        return args[0] === "serve" ? "<p>Rust-first application runtime.</p>" : "";
      },
    });

    assert.deepEqual(calls.map((call) => call.args[0]), ["init", "serve", "check", "build", "serve"]);
    assert.equal(calls[0].cwd, root);
    assert.ok(calls.slice(1).every((call) => call.cwd === join(root, "starter")));
    assert.ok(calls[3].args.includes(join(root, "starter", "node_modules", "@ferrite", "runtime", "bin", "render-page.mjs")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("clean developer workflow rejects an unrelated initial serve failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-clean-workflow-wrong-failure-"));
  const cliSource = join(root, "source-ferrite");
  try {
    await writeFile(cliSource, "candidate cli");
    await assert.rejects(
      verifyCleanDeveloperWorkflow(root, {
        cliSource,
        runCommand: async (_command, args) => {
          if (args[0] === "serve") {
            throw new Error(
              "artifact directory /tmp/starter/.ferrite/build is unavailable: Permission denied (os error 13)",
            );
          }
          return "";
        },
      }),
      /missing build artifact: unexpected failure: artifact directory[\s\S]*Permission denied \(os error 13\)/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("clean developer workflow fails when artifact serve does not render the fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-clean-workflow-failure-"));
  const cliSource = join(root, "source-ferrite");
  let serveCalls = 0;
  try {
    await writeFile(cliSource, "candidate cli");
    await assert.rejects(
      verifyCleanDeveloperWorkflow(root, {
        cliSource,
        runCommand: async (_command, args) => {
          if (args[0] === "serve" && serveCalls++ === 0) {
            throw new Error(
              "artifact directory C:\\starter\\.ferrite\\build is unavailable: The system cannot find the path specified. (os error 3)",
            );
          }
          return args[0] === "serve" ? "wrong page" : "";
        },
      }),
      /did not render the fixture page/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("release package set stays explicit", () => {
  assert.deepEqual(RELEASE_PACKAGE_NAMES, [
    "@ferrite/protocol",
    "@ferrite/protocol-wasm",
    "@ferrite/runtime",
    "@ferrite/node",
  ]);
});

test("release manifest removes private and rewrites workspace dependencies", () => {
  const manifest = createReleaseManifest(
    {
      name: "@ferrite/runtime",
      version: "0.1.0",
      private: true,
      dependencies: {
        "@ferrite/protocol": "workspace:*",
      },
    },
    {
      packageVersions: new Map([
        ["@ferrite/protocol", "0.1.0"],
        ["@ferrite/runtime", "0.1.0"],
      ]),
      nativePackageNames: [],
    },
  );

  assert.equal(Object.hasOwn(manifest, "private"), false);
  assert.deepEqual(manifest.dependencies, {
    "@ferrite/protocol": "0.1.0",
  });
});

test("release manifest adds expected native optional dependencies for @ferrite/node", () => {
  const manifest = createReleaseManifest(
    {
      name: "@ferrite/node",
      version: "0.1.0",
      private: true,
    },
    {
      packageVersions: new Map([["@ferrite/node", "0.1.0"]]),
      nativePackageNames: [
        "@ferrite/node-darwin-arm64",
        "@ferrite/node-linux-x64-gnu",
      ],
    },
  );

  assert.deepEqual(manifest.optionalDependencies, {
    "@ferrite/node-darwin-arm64": "0.1.0",
    "@ferrite/node-linux-x64-gnu": "0.1.0",
  });
});

test("metadata validation reports missing local metadata", () => {
  assert.throws(
    () =>
      validateManifestMetadata({
        packageName: "@ferrite/protocol",
        sourceManifest: {
          name: "@ferrite/protocol",
          version: "0.1.0",
          private: true,
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
        releaseManifest: {
          name: "@ferrite/protocol",
          version: "0.1.0",
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
      }),
    /@ferrite\/protocol: package description is required/,
  );
});

test("publish-manifest mode requires remote metadata", () => {
  assert.throws(
    () =>
      validateManifestMetadata({
        packageName: "@ferrite/protocol",
        sourceManifest: completeSourceManifest("@ferrite/protocol"),
        releaseManifest: completeReleaseManifest("@ferrite/protocol"),
        publishManifestMode: true,
      }),
    /@ferrite\/protocol: publish-manifest mode requires repository metadata/,
  );
});

test("pack file validation accepts required files and rejects forbidden files", () => {
  validatePackFiles({
    packageName: "@ferrite/node",
    files: ["package/binding.js", "package/index.js", "package/index.d.ts"],
    requiredFiles: ["binding.js", "index.js", "index.d.ts"],
    forbiddenFiles: ["dist/ferrite-node.node"],
  });

  assert.throws(
    () =>
      validatePackFiles({
        packageName: "@ferrite/node",
        files: [
          "package/binding.js",
          "package/index.js",
          "package/index.d.ts",
          "package/dist/ferrite-node.node",
        ],
        requiredFiles: ["binding.js", "index.js", "index.d.ts"],
        forbiddenFiles: ["dist/ferrite-node.node"],
      }),
    /@ferrite\/node: packed package must not include dist\/ferrite-node.node/,
  );
});

test("packed manifest validation rejects source-only release blockers", () => {
  const releaseManifest = {
    name: "@ferrite/runtime",
    version: "0.1.0",
    dependencies: {
      "@ferrite/protocol": "0.1.0",
    },
  };

  assert.throws(
    () =>
      validatePackedManifest({
        packageName: "@ferrite/runtime",
        releaseManifest,
        packedManifest: {
          ...releaseManifest,
          private: true,
        },
      }),
    /@ferrite\/runtime: tarball manifest must not contain private/,
  );

  assert.throws(
    () =>
      validatePackedManifest({
        packageName: "@ferrite/runtime",
        releaseManifest,
        packedManifest: {
          name: "@ferrite/runtime",
          version: "0.1.0",
          dependencies: {
            "@ferrite/protocol": "workspace:*",
          },
        },
      }),
    /@ferrite\/runtime: release manifest contains workspace specifier dependencies.@ferrite\/protocol/,
  );
});

test("verifier validates packages and writes the inspected report", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-report-"));
  const buildCalls = [];
  const packCalls = [];
  try {
    const results = await verifyNpmPackages({
      releasePackages: [
        {
          name: "@ferrite/protocol",
          directory: "packages/protocol",
          build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        },
      ],
      nativePackageNames: [],
      packageManifests: new Map([
        [
          "@ferrite/protocol",
          {
            name: "@ferrite/protocol",
            version: "0.1.0",
            private: true,
            description: "Ferrite protocol package.",
            license: "UNLICENSED",
            keywords: ["ferrite"],
            files: ["dist"],
            exports: { ".": "./dist/index.js" },
            publishConfig: { access: "public" },
          },
        ],
      ]),
      reportDir: join(root, "reports"),
      runCommand: async (command, args, options) => {
        buildCalls.push({ command, args, cwd: options.cwd });
        return "";
      },
      packPackage: async (packageDir) => {
        packCalls.push(packageDir);
        return ["package/dist/index.js", "package/dist/index.d.ts"];
      },
      installPackageSet: async () => {},
    });

    const report = JSON.parse(await readFile(join(root, "reports", "npm-package-report.json"), "utf8"));

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "@ferrite/protocol");
    assert.equal(results[0].releaseManifest.private, undefined);
    assert.deepEqual(buildCalls, [
      {
        command: "pnpm",
        args: ["--filter", "@ferrite/protocol", "build"],
        cwd: process.cwd(),
      },
    ]);
    assert.equal(packCalls.length, 1);
    assert.notEqual(packCalls[0], join(process.cwd(), "packages/protocol"));
    assert.deepEqual(report, results);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier packs a staged release manifest instead of the source manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-stage-"));
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await mkdir(join(root, "packages", "runtime", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(join(root, "packages", "runtime", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "runtime", "dist", "index.d.ts"), "export {};\n");
    await writeFile(
      join(root, "packages", "protocol", "package.json"),
      `${JSON.stringify(
        {
          name: "@ferrite/protocol",
          version: "0.1.0",
          private: true,
          description: "Ferrite protocol package.",
          license: "UNLICENSED",
          keywords: ["ferrite"],
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, "packages", "runtime", "package.json"),
      `${JSON.stringify(
        {
          name: "@ferrite/runtime",
          version: "0.1.0",
          private: true,
          description: "Ferrite runtime package.",
          license: "UNLICENSED",
          keywords: ["ferrite"],
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          dependencies: {
            "@ferrite/protocol": "workspace:*",
          },
          publishConfig: { access: "public" },
        },
        null,
        2,
      )}\n`,
    );

    const results = await verifyNpmPackages({
      releasePackages: [
        {
          name: "@ferrite/protocol",
          directory: "packages/protocol",
          build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        },
        {
          name: "@ferrite/runtime",
          directory: "packages/runtime",
          build: ["pnpm", ["--filter", "@ferrite/runtime", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        },
      ],
      nativePackageNames: [],
      workspaceRoot: root,
      reportDir: join(root, "reports"),
      runCommand: async () => "",
      packPackage: async (packageDir) => {
        const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
        assert.equal(Object.hasOwn(manifest, "private"), false);
        assert.notEqual(packageDir, join(root, "packages", manifest.name.replace("@ferrite/", "")));
        if (manifest.name === "@ferrite/runtime") {
          assert.deepEqual(manifest.dependencies, {
            "@ferrite/protocol": "0.1.0",
          });
        }
        return {
          files: ["package/dist/index.js", "package/dist/index.d.ts", "package/package.json"],
          packedManifest: manifest,
        };
      },
      installPackageSet: async () => {},
    });

    const runtimeSourceManifest = JSON.parse(await readFile(join(root, "packages", "runtime", "package.json"), "utf8"));
    assert.equal(runtimeSourceManifest.private, true);
    assert.deepEqual(runtimeSourceManifest.dependencies, {
      "@ferrite/protocol": "workspace:*",
    });
    assert.deepEqual(results[1].packedManifest.dependencies, {
      "@ferrite/protocol": "0.1.0",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier installs all generated local tarballs together in a clean project", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-install-"));
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await mkdir(join(root, "packages", "runtime", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(join(root, "packages", "runtime", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "runtime", "dist", "index.d.ts"), "export {};\n");
    await writeFile(
      join(root, "packages", "protocol", "package.json"),
      `${JSON.stringify(
        {
          name: "@ferrite/protocol",
          version: "0.1.0",
          private: true,
          description: "Ferrite protocol package.",
          license: "UNLICENSED",
          keywords: ["ferrite"],
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, "packages", "runtime", "package.json"),
      `${JSON.stringify(
        {
          name: "@ferrite/runtime",
          version: "0.1.0",
          private: true,
          description: "Ferrite runtime package.",
          license: "UNLICENSED",
          keywords: ["ferrite"],
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          dependencies: {
            "@ferrite/protocol": "workspace:*",
          },
          publishConfig: { access: "public" },
        },
        null,
        2,
      )}\n`,
    );

    const installCalls = [];
    await verifyNpmPackages({
      releasePackages: [
        {
          name: "@ferrite/protocol",
          directory: "packages/protocol",
          build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        },
        {
          name: "@ferrite/runtime",
          directory: "packages/runtime",
          build: ["pnpm", ["--filter", "@ferrite/runtime", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        },
      ],
      nativePackageNames: [],
      workspaceRoot: root,
      reportDir: join(root, "reports"),
      runCommand: async () => "",
      packPackage: async (packageDir) => {
        const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
        return {
          files: ["package/dist/index.js", "package/dist/index.d.ts", "package/package.json"],
          packedManifest: manifest,
          tarballPath: join(root, `${manifest.name.replace("@ferrite/", "")}.tgz`),
        };
      },
      installPackageSet: async (packages) => {
        installCalls.push(packages.map(({ name, tarballPath }) => ({ name, tarballPath })));
      },
    });

    assert.deepEqual(installCalls, [
      [
        { name: "@ferrite/protocol", tarballPath: join(root, "protocol.tgz") },
        { name: "@ferrite/runtime", tarballPath: join(root, "runtime.tgz") },
      ],
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function completeSourceManifest(name) {
  return {
    name,
    version: "0.1.0",
    private: true,
    description: "Ferrite test package.",
    license: "UNLICENSED",
    keywords: ["ferrite"],
    files: ["dist"],
    exports: { ".": "./dist/index.js" },
    publishConfig: { access: "public" },
  };
}

function completeReleaseManifest(name) {
  const manifest = completeSourceManifest(name);
  delete manifest.private;
  return manifest;
}
