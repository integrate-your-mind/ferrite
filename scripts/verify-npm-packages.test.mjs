import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_PACKAGE_NAMES,
  createReleaseManifest,
  validateManifestMetadata,
  validatePackFiles,
  verifyNpmPackages,
} from "./verify-npm-packages.mjs";

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
      packDryRun: async (packageDir) => {
        packCalls.push(packageDir);
        return ["package/dist/index.js", "package/dist/index.d.ts"];
      },
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
    assert.equal(packCalls[0].endsWith("packages/protocol"), true);
    assert.deepEqual(report, results);
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
