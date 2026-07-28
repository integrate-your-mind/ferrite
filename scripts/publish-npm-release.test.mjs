import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { prepareNpmRelease } from "./prepare-npm-release.mjs";
import {
  createPublicationReceipt,
  parsePublishArgs,
  preflightNpmRelease,
  publishNpmRelease,
  removeStagingDirectory,
  stageVerifiedArtifact,
  writePublicationReceipt,
} from "./publish-npm-release.mjs";
import { createPackageReport } from "./verify-npm-packages.mjs";

const version = "0.1.0-alpha.0";
const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
const build = {
  provider: "buildkite",
  organization: "roman-mondello",
  pipeline: "ferrite",
  buildId: "build-123",
  buildNumber: "123",
  jobId: "job-456",
  url: "https://buildkite.com/roman-mondello/ferrite/builds/123",
};
const names = ["@ferrite/protocol", "@ferrite/protocol-wasm", "@ferrite/runtime"];
const acceptBuildkite = async () => {};
const acceptNpmPreflight = async ({ registry, packages, version }) => ({
  registry,
  identity: "release-bot",
  twoFactorAuth: "auth-and-writes",
  org: { organization: "ferrite", identity: "release-bot", role: "developer" },
  access: Object.fromEntries(packages.map(({ name }) => [name, "create"])),
  versions: Object.fromEntries(packages.map(({ name }) => [name, null])),
  packages: packages.map(({ name }) => ({ name, version, exists: false, access: "create" })),
});

test("requires an explicit execute flag", async () => {
  await assert.rejects(publishNpmRelease({ reportPath: "unused" }), /explicit --execute/);
  assert.deepEqual(parsePublishArgs([
    "--report",
    "report.json",
    "--receipt",
    "receipt.json",
    "--execute",
  ]), {
    reportPath: "report.json",
    receiptPath: "receipt.json",
    execute: true,
  });
});

test("npm preflight is fail-closed for authentication, policy, access, and registry JSON", async () => {
  const packages = [{ name: "@ferrite/protocol" }];
  const command = ({ whoami = { username: "release-bot" }, profile = { "two-factor auth": "auth-and-writes" }, org = { "release-bot": "developer" }, access = {}, view = null, error } = {}) => async (_command, args) => {
    assert.equal(args.at(-1), "https://registry.npmjs.org/");
    if (args[0] === "whoami") {
      if (error === "E401") throw Object.assign(new Error("E401"), { stderr: "E401" });
      return whoami;
    }
    if (args[0] === "profile") return profile;
    if (args[0] === "org") return org;
    if (args[0] === "access") {
      assert.deepEqual(args.slice(0, 4), ["access", "list", "packages", "release-bot"]);
      return access;
    }
    if (args[0] === "view") {
      if (error === "malformed") return "not json";
      if (error === "exists") return JSON.stringify(view ?? "0.1.0-alpha.0");
      throw Object.assign(new Error("E404"), { stderr: "npm ERR! code E404" });
    }
    throw new Error(`unexpected npm command ${args.join(" ")}`);
  };
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ error: "E401" }) }),
    /E401|authenticated/,
  );
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ profile: { "two-factor auth": "auth-only" } }) }),
    /auth-and-writes/,
  );
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ org: { "release-bot": "read-only" } }) }),
    /publishable ferrite org role/,
  );
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ access: { "@ferrite/protocol": "read-only" } }) }),
    /read-write/,
  );
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ access: { "@ferrite/protocol": "read-write" }, error: "exists" }) }),
    /exact npm version already exists; refusing overwrite/,
  );
  await assert.rejects(
    preflightNpmRelease({ packages, version, runCommand: command({ error: "malformed" }) }),
    /malformed JSON/,
  );
});

test("refuses to overwrite an existing publication receipt", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const receiptPath = join(root, "existing-publication.json");
    const existing = {
      schemaVersion: 1,
      attemptId: "prior-attempt",
      status: "ambiguous",
      published: [{ name: "@ferrite/protocol" }],
      ambiguous: { name: "@ferrite/protocol-wasm" },
    };
    await createPublicationReceipt(receiptPath, existing);
    let registryCalls = 0;

    await assert.rejects(
      publishNpmRelease({
        reportPath,
        receiptPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: acceptNpmPreflight,
        runCommand: async () => {
          registryCalls += 1;
        },
      }),
      /receipt already exists.*reconcile or archive/,
    );
    assert.equal(registryCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), existing);
  });
});

test("revalidates and publishes immutable staged bytes in dependency order", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const calls = [];
    const receiptPath = join(root, "complete-publication.json");
    const result = await publishNpmRelease({
      reportPath,
      receiptPath,
      execute: true,
      sourceIdentity: source,
      verifyBuildkite: acceptBuildkite,
      npmPreflight: acceptNpmPreflight,
      runCommand: async (command, args, options) => {
        const bytes = await readFile(args[1]);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        assert.equal(receipt.status, "in_progress");
        assert.equal(receipt.attempting.name, names[calls.length]);
        calls.push({
          command,
          args: [args[0], args.slice(2)],
          cwd: options.cwd,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      },
    });

    assert.deepEqual(result.published.map(({ name }) => name), names);
    assert.deepEqual(calls.map(({ command }) => command), ["npm", "npm", "npm"]);
    assert.ok(calls.every(({ args }) =>
      args[0] === "publish" &&
      assert.deepEqual(args[1], ["--access", "public", "--tag", "next", "--registry", "https://registry.npmjs.org/"]) === undefined
    ));
    assert.deepEqual(
      calls.map(({ sha256 }) => sha256),
      result.published.map(({ sha256 }) => sha256),
    );
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    assert.match(receipt.attemptId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.status, "complete");
    assert.deepEqual(receipt.published.map(({ name }) => name), names);
  });
});

test("records a response-loss failure as ambiguous instead of failed", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    let calls = 0;
    const receiptPath = join(root, "partial-publication.json");
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        receiptPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: acceptNpmPreflight,
        runCommand: async () => {
          calls += 1;
          if (calls === 2) throw new Error("registry rejected package");
        },
      }),
      /registry rejected package.*confirmed published: @ferrite\/protocol.*ambiguous registry outcome/,
    );
    assert.equal(calls, 2);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.published.map(({ name }) => name), ["@ferrite/protocol"]);
    assert.equal(receipt.failed, undefined);
    assert.deepEqual(receipt.ambiguous, {
      name: "@ferrite/protocol-wasm",
      phase: "registry_publish",
      reason: "registry outcome must be read back before retry",
    });
  });
});

test("keeps confirmed publication disjoint from a cleanup failure", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const receiptPath = join(root, "cleanup-failure.json");
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        receiptPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: acceptNpmPreflight,
        runCommand: async () => {},
        cleanupStaging: async (stagingRoot) => {
          await removeStagingDirectory(stagingRoot);
          throw new Error("cleanup failed");
        },
      }),
      /confirmed published: @ferrite\/protocol.*confirmed published before a local cleanup_after_confirmed_publish failure/,
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.published.map(({ name }) => name), ["@ferrite/protocol"]);
    assert.equal(receipt.failed, undefined);
    assert.equal(receipt.ambiguous, undefined);
    assert.deepEqual(receipt.postPublicationFailure, {
      name: "@ferrite/protocol",
      phase: "cleanup_after_confirmed_publish",
      reason: "registry success was confirmed but local completion did not finish",
    });
  });
});

test("recovers a post-success receipt write failure without relabeling success", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const receiptPath = join(root, "receipt-write-failure.json");
    let writes = 0;
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        receiptPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: acceptNpmPreflight,
        runCommand: async () => {},
        writeReceipt: async (...args) => {
          writes += 1;
          if (writes === 2) throw new Error("receipt write failed");
          await writePublicationReceipt(...args);
        },
      }),
      /confirmed published: @ferrite\/protocol.*confirmed published before a local receipt_after_confirmed_publish failure/,
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.published.map(({ name }) => name), ["@ferrite/protocol"]);
    assert.equal(receipt.failed, undefined);
    assert.equal(receipt.ambiguous, undefined);
    assert.equal(receipt.postPublicationFailure.phase, "receipt_after_confirmed_publish");
  });
});

test("stops when the package set changes after publication starts", async () => {
  await withReleaseReport(async ({ reportPath, report }) => {
    let calls = 0;
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: acceptNpmPreflight,
        runCommand: async () => {
          calls += 1;
          if (calls === 1) {
            report.packages.push({
              name: "@ferrite/unexpected",
              version,
              publishArtifact: null,
            });
            const changed = createPackageReport({
              packages: report.packages,
              source,
              build,
            });
            await writeFile(reportPath, `${JSON.stringify(changed, null, 2)}\n`);
          }
        },
      }),
      /package set changed after publication started/,
    );
    assert.equal(calls, 1);
  });
});

test("stops when the source or build identity changes between replans", async () => {
  for (const field of ["source", "build"]) {
    await withReleaseReport(async ({ reportPath, report }) => {
      let calls = 0;
      await assert.rejects(
        publishNpmRelease({
          reportPath,
          execute: true,
          sourceIdentity: source,
          verifyBuildkite: acceptBuildkite,
          npmPreflight: acceptNpmPreflight,
          runCommand: async () => {
            calls += 1;
            if (calls === 1) {
              const changed = createPackageReport({
                packages: report.packages,
                source: field === "source" ? { ...source, tree: "c".repeat(40) } : source,
                build: field === "build" ? { ...build, buildId: "build-drift" } : build,
              });
              await writeFile(reportPath, `${JSON.stringify(changed, null, 2)}\n`);
            }
          },
        }),
        /source commit\/tree does not match|source\/build identity changed/,
      );
      assert.equal(calls, 1);
    });
  }
});

test("stops when authenticated npm identity drifts before publish", async () => {
  await withReleaseReport(async ({ reportPath }) => {
    let preflights = 0;
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        execute: true,
        sourceIdentity: source,
        verifyBuildkite: acceptBuildkite,
        npmPreflight: async (options) => ({
          ...await acceptNpmPreflight(options),
          identity: preflights++ === 0 ? "release-bot" : "different-bot",
        }),
        runCommand: async () => {},
      }),
      /registry identity\/access\/version evidence changed/,
    );
  });
});

test("rejects an artifact replaced after planning before immutable staging", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const plan = await prepareNpmRelease({
      reportPath,
      sourceIdentity: source,
      verifyBuildkite: acceptBuildkite,
    });
    const [pkg] = plan.packages;
    await writeFile(pkg.artifact.path, "replaced after plan\n");
    const stagingRoot = await mkdtemp(join(tmpdir(), "ferrite-publish-stage-test-"));
    try {
      await assert.rejects(
        stageVerifiedArtifact(pkg, stagingRoot),
        /changed after release planning/,
      );
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
      assert.ok(root);
    }
  });
});

async function withReleaseReport(callback) {
  const root = await mkdtemp(join(tmpdir(), "ferrite-publish-test-"));
  const tarballs = join(root, "tarballs");
  const reportPath = join(root, "npm-package-report.json");
  try {
    await mkdir(tarballs);
    const packages = [];
    for (const name of names) {
      const manifest = {
        name,
        version,
        publishConfig: { access: "public" },
        ...(name === "@ferrite/protocol"
          ? {}
          : { dependencies: { "@ferrite/protocol": version } }),
      };
      const filename = `${name.replace("@ferrite/", "")}-${version}.tgz`;
      const bytes = npmTarball({
        "package/package.json": `${JSON.stringify(manifest)}\n`,
        "package/dist/index.js": `export const packageName = ${JSON.stringify(name)};\n`,
      });
      await writeFile(join(tarballs, filename), bytes);
      packages.push({
        name,
        version,
        files: ["dist/index.js", "package.json"],
        packedManifest: manifest,
        publishArtifact: {
          path: `tarballs/${filename}`,
          filename,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    }
    const report = createPackageReport({ packages, source, build });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await callback({ root, reportPath, report });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function npmTarball(entries) {
  const chunks = [];
  for (const [path, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, path);
    writeTarString(header, 100, 8, "0000644");
    writeTarString(header, 108, 8, "0000000");
    writeTarString(header, 116, 8, "0000000");
    writeTarString(header, 124, 12, `${bytes.byteLength.toString(8).padStart(11, "0")}\0`);
    writeTarString(header, 136, 12, "00000000000");
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.byteLength <= length, `tar field overflow for ${value}`);
  bytes.copy(buffer, offset, 0, bytes.byteLength);
}
