import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  RELEASE_PACKAGE_NAMES,
  createReleaseManifest,
  normalizeNpmPackJsonEntry,
  npmPackPackage,
  packCurrentNativePrebuild,
  validateManifestMetadata,
  validatePackFiles,
  validatePackedLicense,
  validatePackedManifest,
  verifyCleanDeveloperWorkflow,
  verifyNpmPackages,
} from "./verify-npm-packages.mjs";
import { nativePrebuildPackageName } from "../packages/node/binding.js";

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

test("verifier preserves an interrupted same-directory backup and refuses regeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-backup-guard-"));
  const reportDir = join(root, "reports");
  const backup = join(reportDir, ".previous-report-interrupted");
  const priorReport = join(backup, "npm-package-report.json");
  const priorText = "prior report bytes\n";
  try {
    await mkdir(backup, { recursive: true });
    await writeFile(priorReport, priorText);
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
        releasePackages: [],
        workspaceRoot: root,
        reportDir,
        runCommand: async () => {
          throw new Error("build must not run");
        },
      }),
      /interrupted backup exists.*preserve and reconcile it first/,
    );
    assert.equal(await readFile(priorReport, "utf8"), priorText);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("verifier preserves an interrupted verification lock and refuses regeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-lock-guard-"));
  const reportDir = join(root, "reports");
  const lock = join(reportDir, ".verification-lock");
  const marker = join(lock, "operator-note");
  const markerText = "preserve this interrupted transaction\n";
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(marker, markerText);
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
        releasePackages: [],
        workspaceRoot: root,
        reportDir,
        runCommand: async () => {
          throw new Error("build must not run");
        },
      }),
      /verification lock exists.*preserve and reconcile/,
    );
    assert.equal(await readFile(marker, "utf8"), markerText);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("concurrent report verifiers fail closed instead of interleaving output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-concurrency-guard-"));
  const reportDir = join(root, "reports");
  const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
  const packageFixture = await createMinimalProtocolReleaseFixture(root);
  let installed = 0;
  let releaseInstalls;
  let allInstalledResolve;
  const installGate = new Promise((resolve) => {
    releaseInstalls = resolve;
  });
  const allInstalled = new Promise((resolve) => {
    allInstalledResolve = resolve;
  });
  const installPackageSet = async () => {
    installed += 1;
    if (installed === 2) allInstalledResolve();
    await installGate;
  };
  let lockHeldResolve;
  let releaseWinner;
  const lockHeld = new Promise((resolve) => {
    lockHeldResolve = resolve;
  });
  const winnerGate = new Promise((resolve) => {
    releaseWinner = resolve;
  });
  const readSourceIdentity = () => {
    let reads = 0;
    return async () => {
      reads += 1;
      if (reads === 2) {
        lockHeldResolve();
        await winnerGate;
      }
      return source;
    };
  };
  const invoke = () =>
    verifyNpmPackages({
      buildIdentity: testReportIdentity.buildIdentity,
      ...packageFixture,
      workspaceRoot: root,
      reportDir,
      readSourceIdentity: readSourceIdentity(),
      runCommand: async () => {},
      installPackageSet,
    });

  try {
    const first = invoke();
    const second = invoke();
    await allInstalled;
    releaseInstalls();
    await lockHeld;
    const firstSettlement = await Promise.race([
      first.then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ reason, status: "rejected" }),
      ),
      second.then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ reason, status: "rejected" }),
      ),
    ]);
    assert.equal(firstSettlement.status, "rejected");
    assert.match(firstSettlement.reason?.message ?? "", /verification lock exists/);
    releaseWinner();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.match(rejected?.reason?.message ?? "", /verification lock exists/);
    assert.doesNotMatch(
      (await readdir(reportDir)).join("\n"),
      /^\.verification-lock$|^\.previous-report-/m,
    );
  } finally {
    releaseInstalls?.();
    releaseWinner?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("backup rename failures preserve all prior release evidence", async (t) => {
  for (const { failureAt, label } of [
    { failureAt: 1, label: "first backup rename" },
    { failureAt: 2, label: "second backup rename" },
  ]) {
    await t.test(label, async () => {
      const root = await mkdtemp(join(tmpdir(), "ferrite-npm-backup-failure-"));
      const reportDir = join(root, "reports");
      const reportPath = join(reportDir, "npm-package-report.json");
      const tarballPath = join(reportDir, "tarballs", "prior.tgz");
      const priorReport = "prior report bytes\n";
      const priorTarball = Buffer.from("prior tarball bytes\n");
      let renameCalls = 0;
      try {
        const packageFixture = await createMinimalProtocolReleaseFixture(root);
        await mkdir(dirname(tarballPath), { recursive: true });
        await writeFile(reportPath, priorReport);
        await writeFile(tarballPath, priorTarball);
        await assert.rejects(
          verifyNpmPackages({
            ...testReportIdentity,
            ...packageFixture,
            workspaceRoot: root,
            reportDir,
            runCommand: async () => {},
            installPackageSet: async () => {},
            renamePath: async (source, destination) => {
              renameCalls += 1;
              if (renameCalls === failureAt) {
                const error = new Error(`injected ${label} failure`);
                error.code = "EIO";
                throw error;
              }
              await rename(source, destination);
            },
          }),
          new RegExp(`injected ${label} failure`),
        );
        assert.equal(await readFile(reportPath, "utf8"), priorReport);
        assert.deepEqual(await readFile(tarballPath), priorTarball);
        assert.doesNotMatch(
          (await readdir(reportDir)).join("\n"),
          /^\.verification-lock$|^\.previous-report-/m,
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
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
    assert.equal((await readdir(reportDir)).includes(".verification-lock"), false);
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
    assert.equal((await readdir(reportDir)).includes(".verification-lock"), false);
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
  const phases = [];
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
      onPhase: (phase) => phases.push(phase),
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
    assert.deepEqual(phases, [
      "starter:init",
      "starter:install",
      "starter:check",
      "starter:publish",
      "starter:published",
      "consumer:missing-artifact",
      "consumer:build",
      "consumer:serve",
      "consumer:served",
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

test("pack file validation requires the staged repository license when configured", () => {
  assert.throws(
    () =>
      validatePackFiles({
        packageName: "@ferrite/protocol",
        files: ["package/dist/index.js"],
        requiredFiles: ["dist/index.js", "LICENSE"],
        forbiddenFiles: [],
      }),
    /@ferrite\/protocol: packed package must include LICENSE/,
  );
  validatePackedLicense({
    packageName: "@ferrite/protocol",
    expectedLicenseContent: "license bytes\n",
    packedLicenseContent: Buffer.from("license bytes\n"),
  });
  assert.throws(
    () =>
      validatePackedLicense({
        packageName: "@ferrite/protocol",
        expectedLicenseContent: "license bytes\n",
        packedLicenseContent: Buffer.from("tampered\n"),
      }),
    /packed LICENSE does not match the repository LICENSE/,
  );
  assert.throws(
    () =>
      validatePackedLicense({
        packageName: "@ferrite/protocol",
        expectedLicenseContent: "license bytes\n",
      }),
    /packed package must include LICENSE/,
  );
});

test("npm pack generation accepts npm 11 keyed and legacy array JSON", async (context) => {
  for (const shape of ["keyed", "array"]) {
    await context.test(shape, async () => {
      const root = await mkdtemp(join(tmpdir(), "ferrite-npm-pack-json-"));
      const packageDir = join(root, "package");
      const tarballDir = join(root, ".tarballs");
      const manifest = completeReleaseManifest("@ferrite/runtime");
      const filename = "ferrite-runtime-0.1.0.tgz";
      const bytes = npmTarball({
        "package/package.json": `${JSON.stringify(manifest)}\n`,
        "package/LICENSE": "Ferrite test license\n",
      });
      const entry = {
        filename,
        size: bytes.byteLength,
        files: [
          { path: "package.json" },
          { path: "LICENSE" },
        ],
      };
      try {
        await mkdir(packageDir, { recursive: true });
        const result = await npmPackPackage(packageDir, {
          runCommand: async (command, args, options) => {
            assert.equal(command, "npm");
            assert.deepEqual(
              args,
              ["pack", "--json", "--pack-destination", tarballDir],
            );
            assert.equal(options.cwd, packageDir);
            assert.equal(options.capture, true);
            await writeFile(join(tarballDir, filename), bytes);
            return JSON.stringify(
              shape === "keyed" ? { "0": entry } : [entry],
            );
          },
        });
        assert.deepEqual(result.files, ["package.json", "LICENSE"]);
        assert.deepEqual(result.packedManifest, manifest);
        assert.equal(result.tarballPath, join(tarballDir, filename));
        assert.equal(result.npmReportedSize, bytes.byteLength);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }
});

test("npm pack generation rejects a keyed result without a file list", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-pack-malformed-"));
  const packageDir = join(root, "package");
  try {
    await mkdir(packageDir, { recursive: true });
    await assert.rejects(
      npmPackPackage(packageDir, {
        runCommand: async () =>
          JSON.stringify({
            "0": {
              filename: "ferrite-runtime-0.1.0.tgz",
              size: 1,
            },
          }),
      }),
      /did not include a file list/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("npm pack JSON normalization supports legacy arrays and rejects ambiguous shapes", () => {
  const entry = {
    filename: "ferrite-runtime-0.1.0.tgz",
    size: 1,
    files: [{ path: "package.json" }],
  };
  assert.equal(
    normalizeNpmPackJsonEntry([entry], "fixture"),
    entry,
  );
  assert.throws(
    () => normalizeNpmPackJsonEntry({}, "fixture"),
    /must identify exactly one package/,
  );
  assert.throws(
    () =>
      normalizeNpmPackJsonEntry(
        { "0": entry, "1": { ...entry, filename: "second.tgz" } },
        "fixture",
      ),
    /must identify exactly one package/,
  );
  assert.throws(
    () => normalizeNpmPackJsonEntry({ "0": [entry] }, "fixture"),
    /must identify exactly one package/,
  );
});

test("npm pack generation rejects unsafe keyed tarball filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-pack-unsafe-"));
  const packageDir = join(root, "package");
  try {
    await mkdir(packageDir, { recursive: true });
    await assert.rejects(
      npmPackPackage(packageDir, {
        runCommand: async () =>
          JSON.stringify({
            "0": {
              filename: "../outside.tgz",
              size: 1,
              files: [{ path: "package.json" }],
            },
          }),
      }),
      /unsafe tarball filename/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("publish-manifest verification fails closed when the repository license is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-missing-license-"));
  try {
    await assert.rejects(
      verifyNpmPackages({
        ...testReportIdentity,
        publishManifestMode: true,
        releasePackages: [],
        workspaceRoot: root,
        reportDir: join(root, "reports"),
        runCommand: async () => {
          throw new Error("build must not run");
        },
      }),
      /publish-manifest verification requires the repository LICENSE/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("native prebuild staging includes the exact repository license", async (context) => {
  const packageName = nativePrebuildPackageName();
  if (!packageName) {
    context.skip("current platform has no Ferrite native prebuild mapping");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ferrite-native-license-"));
  const stageRoot = join(root, "stage");
  const licenseContent = Buffer.from("Ferrite MIT license bytes\n");
  try {
    await mkdir(stageRoot, { recursive: true });
    const result = await packCurrentNativePrebuild({
      packageWorkspaceRoot: root,
      stageRoot,
      licenseContent,
      createPrebuildPackageImpl: async ({ destinationRoot }) => {
        await mkdir(destinationRoot, { recursive: true });
        await writeFile(
          join(destinationRoot, "package.json"),
          `${JSON.stringify({
            ...completeReleaseManifest(packageName),
            license: "MIT",
          })}\n`,
        );
        await writeFile(join(destinationRoot, "ferrite-node.node"), "binding");
        await writeFile(
          join(destinationRoot, "ferrite-node.sha256.json"),
          "{}\n",
        );
      },
      verifyPrebuildPackageDirsImpl: async (directories, options) => {
        assert.deepEqual(options.expectedPackages, [packageName]);
        assert.equal(directories.length, 1);
      },
      packPackage: async (directory) => {
        assert.deepEqual(
          await readFile(join(directory, "LICENSE")),
          licenseContent,
        );
        return {
          files: [
            "package/ferrite-node.node",
            "package/ferrite-node.sha256.json",
            "package/LICENSE",
            "package/package.json",
          ],
          packedManifest: {
            ...completeReleaseManifest(packageName),
            license: "MIT",
          },
        };
      },
    });
    assert.equal(result.name, packageName);
    assert.ok(result.files.includes("package/LICENSE"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("native prebuild tarball contains the exact repository license", async (context) => {
  const packageName = nativePrebuildPackageName();
  if (!packageName) {
    context.skip("current platform has no Ferrite native prebuild mapping");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ferrite-native-license-tarball-"));
  const stageRoot = join(root, "stage");
  const licenseContent = Buffer.from("Ferrite MIT license bytes\n");
  try {
    await mkdir(stageRoot, { recursive: true });
    const result = await packCurrentNativePrebuild({
      packageWorkspaceRoot: root,
      stageRoot,
      licenseContent,
      createPrebuildPackageImpl: createNativePrebuildFixture(packageName),
      verifyPrebuildPackageDirsImpl: async () => {},
      packPackage: packNativeFixtureTarball({
        packageName,
        stageRoot,
        licenseContent,
      }),
    });
    assert.equal(result.name, packageName);
    assert.match(result.tarball?.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("native prebuild tarball rejects a tampered license", async (context) => {
  const packageName = nativePrebuildPackageName();
  if (!packageName) {
    context.skip("current platform has no Ferrite native prebuild mapping");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ferrite-native-license-tamper-"));
  const stageRoot = join(root, "stage");
  const licenseContent = Buffer.from("Ferrite MIT license bytes\n");
  try {
    await mkdir(stageRoot, { recursive: true });
    await assert.rejects(
      packCurrentNativePrebuild({
        packageWorkspaceRoot: root,
        stageRoot,
        licenseContent,
        createPrebuildPackageImpl: createNativePrebuildFixture(packageName),
        verifyPrebuildPackageDirsImpl: async () => {},
        packPackage: packNativeFixtureTarball({
          packageName,
          stageRoot,
          licenseContent: Buffer.from("tampered license bytes\n"),
        }),
      }),
      /packed LICENSE does not match the repository LICENSE/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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
        return ["package/dist/index.js", "package/dist/index.d.ts", "package/LICENSE"];
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
  const licenseText = "Ferrite test MIT license\n";
  try {
    await writeFile(join(root, "LICENSE"), licenseText);
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
        assert.equal(await readFile(join(packageDir, "LICENSE"), "utf8"), licenseText);
        if (manifest.name === "@ferrite/runtime") {
          assert.deepEqual(manifest.dependencies, {
            "@ferrite/protocol": "0.1.0",
          });
        }
        return {
          files: ["package/dist/index.js", "package/dist/index.d.ts", "package/LICENSE", "package/package.json"],
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

async function createMinimalProtocolReleaseFixture(root) {
  const packageDir = join(root, "packages", "protocol");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(join(packageDir, "dist", "index.js"), "export {};\n");
  await writeFile(join(packageDir, "dist", "index.d.ts"), "export {};\n");
  return {
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
      ["@ferrite/protocol", completeSourceManifest("@ferrite/protocol")],
    ]),
    packPackage: async () => ({
      files: ["package/dist/index.js", "package/dist/index.d.ts"],
      packedManifest: completeReleaseManifest("@ferrite/protocol"),
    }),
  };
}

function createNativePrebuildFixture(packageName) {
  return async ({ destinationRoot }) => {
    await mkdir(destinationRoot, { recursive: true });
    await writeFile(
      join(destinationRoot, "package.json"),
      `${JSON.stringify({
        ...completeReleaseManifest(packageName),
        license: "MIT",
      })}\n`,
    );
    await writeFile(join(destinationRoot, "ferrite-node.node"), "binding");
    await writeFile(
      join(destinationRoot, "ferrite-node.sha256.json"),
      "{}\n",
    );
  };
}

function packNativeFixtureTarball({
  packageName,
  stageRoot,
  licenseContent,
}) {
  return async (directory) => {
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const tarballBytes = npmTarball({
      "package/package.json": `${JSON.stringify(manifest)}\n`,
      "package/ferrite-node.node": "binding",
      "package/ferrite-node.sha256.json": "{}\n",
      "package/LICENSE": licenseContent,
    });
    const tarballPath = join(stageRoot, `${packageName.replace("@ferrite/", "")}.tgz`);
    await writeFile(tarballPath, tarballBytes);
    return {
      files: [
        "package/ferrite-node.node",
        "package/ferrite-node.sha256.json",
        "package/LICENSE",
        "package/package.json",
      ],
      packedManifest: manifest,
      tarballPath,
      size: tarballBytes.byteLength,
    };
  };
}

function npmTarball(entries) {
  const chunks = [];
  for (const [path, content] of Object.entries(entries)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, path);
    writeTarString(header, 100, 8, "0000644");
    writeTarString(header, 108, 8, "0000000");
    writeTarString(header, 116, 8, "0000000");
    writeTarString(
      header,
      124,
      12,
      `${bytes.byteLength.toString(8).padStart(11, "0")}\0`,
    );
    writeTarString(header, 136, 12, "00000000000");
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(
      header,
      148,
      8,
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    chunks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.byteLength % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.byteLength <= length, `tar field overflow for ${value}`);
  bytes.copy(buffer, offset, 0, bytes.byteLength);
}
