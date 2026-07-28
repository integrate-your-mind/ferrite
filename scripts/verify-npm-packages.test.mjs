import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const testReportIdentity = {
  sourceIdentity: {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  },
  buildIdentity: {
    provider: "buildkite",
    organization: "roman-mondello",
    pipeline: "ferrite",
    buildId: "build-123",
    buildNumber: "123",
    jobId: "job-456",
    url: "https://buildkite.com/roman-mondello/ferrite/builds/123",
  },
};

test("verifier preserves a publication receipt and refuses regeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-receipt-guard-"));
  const reportDir = join(root, "reports");
  const receipt = join(reportDir, "nested", "npm-publication-receipt.json");
  const receiptText = '{"status":"ambiguous","published":[]}\n';
  try {
    await mkdir(join(reportDir, "nested"), { recursive: true });
    await writeFile(receipt, receiptText);
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
        releasePackages: [],
        workspaceRoot: root,
        reportDir,
        runCommand: async () => { throw new Error("build must not run"); },
      }),
      /refuses to regenerate artifacts while publication receipt exists/,
    );
    assert.equal(await readFile(receipt, "utf8"), receiptText);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source drift before report replacement preserves prior generated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-source-drift-"));
  const reportDir = join(root, "reports");
  const reportPath = join(reportDir, "npm-package-report.json");
  const tarballPath = join(reportDir, "tarballs", "prior.tgz");
  const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
  let sourceReads = 0;
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "package.json"), `${JSON.stringify(completeSourceManifest("@ferrite/protocol"))}\n`);
    await mkdir(join(reportDir, "tarballs"), { recursive: true });
    const priorReport = "prior report bytes\n";
    const priorTarball = Buffer.from("prior tarball bytes\n");
    await writeFile(reportPath, priorReport);
    await writeFile(tarballPath, priorTarball);
    await assert.rejects(
      verifyNpmPackages({
        buildIdentity: testReportIdentity.buildIdentity,
        releasePackages: [{
          name: "@ferrite/protocol",
          directory: "packages/protocol",
          build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        }],
        nativePackageNames: [],
        workspaceRoot: root,
        reportDir,
        readSourceIdentity: async () => sourceReads++ === 0 ? source : { ...source, tree: "c".repeat(40) },
        runCommand: async () => {},
        packPackage: async () => ({ files: ["package/dist/index.js", "package/dist/index.d.ts"] }),
        installPackageSet: async () => {},
      }),
      /source commit\/tree changed during verification/,
    );
    assert.equal(await readFile(reportPath, "utf8"), priorReport);
    assert.deepEqual(await readFile(tarballPath), priorTarball);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source drift after report persistence restores prior generated artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-persisted-source-drift-"));
  const reportDir = join(root, "reports");
  const reportPath = join(reportDir, "npm-package-report.json");
  const tarballPath = join(reportDir, "tarballs", "prior.tgz");
  const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
  let sourceReads = 0;
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(
      join(root, "packages", "protocol", "package.json"),
      `${JSON.stringify(completeSourceManifest("@ferrite/protocol"))}\n`,
    );
    await mkdir(join(reportDir, "tarballs"), { recursive: true });
    const priorReport = "prior report bytes\n";
    const priorTarball = Buffer.from("prior tarball bytes\n");
    await writeFile(reportPath, priorReport);
    await writeFile(tarballPath, priorTarball);
    await assert.rejects(
      verifyNpmPackages({
        buildIdentity: testReportIdentity.buildIdentity,
        releasePackages: [{
          name: "@ferrite/protocol",
          directory: "packages/protocol",
          build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
          requiredFiles: ["dist/index.js", "dist/index.d.ts"],
          forbiddenFiles: ["src/index.ts", "test"],
        }],
        nativePackageNames: [],
        workspaceRoot: root,
        reportDir,
        readSourceIdentity: async () =>
          sourceReads++ < 3 ? source : { ...source, tree: "c".repeat(40) },
        runCommand: async () => {},
        packPackage: async () => ({
          files: ["package/dist/index.js", "package/dist/index.d.ts"],
        }),
        installPackageSet: async () => {},
      }),
      /source commit\/tree changed during verification/,
    );
    assert.equal(await readFile(reportPath, "utf8"), priorReport);
    assert.deepEqual(await readFile(tarballPath), priorTarball);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("clean developer workflow rejects a missing artifact before building and then serves it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-clean-workflow-"));
  const cliSource = join(root, "source-ferrite");
  const protocolTarball = join(root, "protocol.tgz");
  const runtimeTarball = join(root, "runtime.tgz");
  const calls = [];
  try {
    await writeFile(cliSource, "candidate cli");
    await writeFile(protocolTarball, "protocol candidate");
    await writeFile(runtimeTarball, "runtime candidate");
    await verifyCleanDeveloperWorkflow(root, {
      cliSource,
      packages: [
        { name: "@ferrite/protocol", tarballPath: protocolTarball },
        { name: "@ferrite/runtime", tarballPath: runtimeTarball },
      ],
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command === cliSource && args[0] === "init") {
          await mkdir(args[1], { recursive: true });
          await writeFile(
            join(args[1], "package.json"),
            `${JSON.stringify({
              private: true,
              scripts: { check: "ferrite check", build: "ferrite build" },
              dependencies: { "@ferrite/runtime": "0.1.0" },
            })}\n`,
          );
          await writeFile(join(args[1], ".gitignore"), "node_modules/\n");
        }
        if (args[0] === "serve" && calls.filter((call) => call.args[0] === "serve").length === 1) {
          throw new Error(
            "artifact directory /tmp/starter/.ferrite/build is unavailable: No such file or directory (os error 2)",
          );
        }
        return args[0] === "serve" ? "<p>Rust-first application runtime.</p>" : "";
      },
    });

    assert.deepEqual(calls.map((call) => call.args[0]), [
      "init",
      "install",
      "run",
      "internal-publish-dir",
      "serve",
      "build",
      "serve",
    ]);
    assert.equal(calls[0].cwd, root);
    assert.match(calls[0].args[1], /\.starter\.ferrite-starter-/);
    assert.equal(calls[1].cwd, calls[0].args[1]);
    assert.equal(calls[2].cwd, calls[0].args[1]);
    assert.equal(calls[3].cwd, root);
    assert.ok(calls.slice(4).every((call) => call.cwd === join(root, "starter")));
    assert.ok(calls[5].args.includes(join(root, "starter", "node_modules", "@ferrite", "runtime", "bin", "render-page.mjs")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("clean developer workflow rejects an unrelated initial serve failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-clean-workflow-wrong-failure-"));
  const cliSource = join(root, "source-ferrite");
  const protocolTarball = join(root, "protocol.tgz");
  const runtimeTarball = join(root, "runtime.tgz");
  try {
    await writeFile(cliSource, "candidate cli");
    await writeFile(protocolTarball, "protocol candidate");
    await writeFile(runtimeTarball, "runtime candidate");
    await assert.rejects(
      verifyCleanDeveloperWorkflow(root, {
        cliSource,
        packages: [
          { name: "@ferrite/protocol", tarballPath: protocolTarball },
          { name: "@ferrite/runtime", tarballPath: runtimeTarball },
        ],
        runCommand: async (command, args) => {
          if (command === cliSource && args[0] === "init") {
            await mkdir(args[1], { recursive: true });
            await writeFile(
              join(args[1], "package.json"),
              `${JSON.stringify({
                private: true,
                scripts: { check: "ferrite check", build: "ferrite build" },
                dependencies: { "@ferrite/runtime": "0.1.0" },
              })}\n`,
            );
            await writeFile(join(args[1], ".gitignore"), "node_modules/\n");
          }
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
  const protocolTarball = join(root, "protocol.tgz");
  const runtimeTarball = join(root, "runtime.tgz");
  let serveCalls = 0;
  try {
    await writeFile(cliSource, "candidate cli");
    await writeFile(protocolTarball, "protocol candidate");
    await writeFile(runtimeTarball, "runtime candidate");
    await assert.rejects(
      verifyCleanDeveloperWorkflow(root, {
        cliSource,
        packages: [
          { name: "@ferrite/protocol", tarballPath: protocolTarball },
          { name: "@ferrite/runtime", tarballPath: runtimeTarball },
        ],
        runCommand: async (command, args) => {
          if (command === cliSource && args[0] === "init") {
            await mkdir(args[1], { recursive: true });
            await writeFile(
              join(args[1], "package.json"),
              `${JSON.stringify({
                private: true,
                scripts: { check: "ferrite check", build: "ferrite build" },
                dependencies: { "@ferrite/runtime": "0.1.0" },
              })}\n`,
            );
            await writeFile(join(args[1], ".gitignore"), "node_modules/\n");
          }
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

  const sourceManifest = completeSourceManifest("@ferrite/protocol");
  delete sourceManifest.engines;
  assert.throws(
    () =>
      validateManifestMetadata({
        packageName: "@ferrite/protocol",
        sourceManifest,
        releaseManifest: completeReleaseManifest("@ferrite/protocol"),
      }),
    /@ferrite\/protocol: engines\.node is required/,
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
      ...testReportIdentity,
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
            engines: { node: ">=22" },
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
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.source, testReportIdentity.sourceIdentity);
    assert.deepEqual(report.build, testReportIdentity.buildIdentity);
    assert.match(report.packageSetSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.packages, results);
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
          engines: { node: ">=22" },
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
          engines: { node: ">=22" },
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
      ...testReportIdentity,
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

test("verifier persists tarball identity without temporary paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-identity-"));
  const tarballBytes = Buffer.from("real tarball bytes\n");
  let tarballPath;
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    const results = await verifyNpmPackages({
      ...testReportIdentity,
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
      packageManifests: new Map([["@ferrite/protocol", completeSourceManifest("@ferrite/protocol")]]),
      workspaceRoot: root,
      reportDir: join(root, "reports"),
      runCommand: async () => "",
      packPackage: async (packageDir) => {
        const tarballDir = join(dirname(packageDir), ".tarballs");
        tarballPath = join(tarballDir, "protocol-0.1.0.tgz");
        await mkdir(tarballDir, { recursive: true });
        await writeFile(tarballPath, tarballBytes);
        return {
          files: ["package/dist/index.js", "package/dist/index.d.ts"],
          packedManifest: completeReleaseManifest("@ferrite/protocol"),
          tarballPath,
          size: tarballBytes.byteLength,
        };
      },
      installPackageSet: async () => {},
    });

    const reportText = await readFile(join(root, "reports", "npm-package-report.json"), "utf8");
    const report = JSON.parse(reportText);
    const identity = {
      filename: "protocol-0.1.0.tgz",
      size: tarballBytes.byteLength,
      sha256: createHash("sha256").update(tarballBytes).digest("hex"),
    };
    assert.deepEqual(results[0].tarball, identity);
    assert.deepEqual(report.packages[0].tarball, identity);
    assert.deepEqual(report.packages[0].publishArtifact, {
      path: "tarballs/protocol-0.1.0.tgz",
      ...identity,
    });
    assert.deepEqual(
      await readFile(join(root, "reports", "tarballs", "protocol-0.1.0.tgz")),
      tarballBytes,
    );
    assert.equal(reportText.includes(root), false);
    assert.equal(reportText.includes(tarballPath), false);
    assert.doesNotMatch(reportText, /real tarball bytes/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier rejects inconsistent npm tarball size metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-size-"));
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
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
        packageManifests: new Map([["@ferrite/protocol", completeSourceManifest("@ferrite/protocol")]]),
        workspaceRoot: root,
        reportDir: join(root, "reports"),
        runCommand: async () => "",
        packPackage: async (packageDir) => {
          const tarballDir = join(dirname(packageDir), ".tarballs");
          const tarballPath = join(tarballDir, "protocol-0.1.0.tgz");
          await mkdir(tarballDir, { recursive: true });
          await writeFile(tarballPath, "actual tarball\n");
          return {
            files: ["package/dist/index.js", "package/dist/index.d.ts"],
            packedManifest: completeReleaseManifest("@ferrite/protocol"),
            tarballPath,
            size: 999,
          };
        },
        installPackageSet: async () => {},
      }),
      /@ferrite\/protocol: npm pack reported tarball size 999, actual bytes are 15/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier rejects tarballs outside its staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-containment-"));
  const outsideTarballPath = join(root, "outside.tgz");
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(outsideTarballPath, "outside bytes\n");
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
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
        packageManifests: new Map([["@ferrite/protocol", completeSourceManifest("@ferrite/protocol")]]),
        workspaceRoot: root,
        reportDir: join(root, "reports"),
        runCommand: async () => "",
        packPackage: async () => ({
          files: ["package/dist/index.js", "package/dist/index.d.ts"],
          packedManifest: completeReleaseManifest("@ferrite/protocol"),
          tarballPath: outsideTarballPath,
        }),
        installPackageSet: async () => {},
      }),
      /@ferrite\/protocol: packed tarball resolves outside the staging directory/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier rejects staged tarball symlinks that resolve outside staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-symlink-"));
  const outsideTarballPath = join(root, "outside.tgz");
  try {
    await mkdir(join(root, "packages", "protocol", "dist"), { recursive: true });
    await writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export {};\n");
    await writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"), "export {};\n");
    await writeFile(outsideTarballPath, "outside bytes\n");
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
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
        packageManifests: new Map([["@ferrite/protocol", completeSourceManifest("@ferrite/protocol")]]),
        workspaceRoot: root,
        reportDir: join(root, "reports"),
        runCommand: async () => "",
        packPackage: async (packageDir) => {
          const tarballDir = join(dirname(packageDir), ".tarballs");
          const tarballPath = join(tarballDir, "protocol-0.1.0.tgz");
          await mkdir(tarballDir, { recursive: true });
          await symlink(outsideTarballPath, tarballPath);
          return {
            files: ["package/dist/index.js", "package/dist/index.d.ts"],
            packedManifest: completeReleaseManifest("@ferrite/protocol"),
            tarballPath,
          };
        },
        installPackageSet: async () => {},
      }),
      /@ferrite\/protocol: packed tarball resolves outside the staging directory/,
    );
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
          engines: { node: ">=22" },
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
          engines: { node: ">=22" },
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
      ...testReportIdentity,
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
        const tarballDir = join(dirname(packageDir), ".tarballs");
        const tarballPath = join(tarballDir, `${manifest.name.replace("@ferrite/", "")}.tgz`);
        await mkdir(tarballDir, { recursive: true });
        await writeFile(tarballPath, `${manifest.name} tarball\n`);
        return {
          files: ["package/dist/index.js", "package/dist/index.d.ts", "package/package.json"],
          packedManifest: manifest,
          tarballPath,
        };
      },
      installPackageSet: async (packages) => {
        installCalls.push(packages.map(({ name, tarballPath }) => ({ name, tarballPath })));
      },
    });

    assert.deepEqual(
      installCalls.map((packages) =>
        packages.map(({ name, tarballPath }) => ({ name, filename: basename(tarballPath) })),
      ),
      [
        [
          { name: "@ferrite/protocol", filename: "protocol.tgz" },
          { name: "@ferrite/runtime", filename: "runtime.tgz" },
        ],
      ],
    );
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
    engines: { node: ">=22" },
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
