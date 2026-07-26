import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { prepareNpmRelease } from "./prepare-npm-release.mjs";
import {
  parsePublishArgs,
  publishNpmRelease,
  stageVerifiedArtifact,
} from "./publish-npm-release.mjs";
import { createPackageReport } from "./verify-npm-packages.mjs";

const version = "0.1.0-alpha.0";
const source = { commit: "a".repeat(40), tree: "b".repeat(40) };
const build = {
  provider: "buildkite",
  buildId: "build-123",
  buildNumber: "123",
  jobId: "job-456",
  url: "https://buildkite.example.test/ferrite/builds/123",
};
const names = ["@ferrite/protocol", "@ferrite/protocol-wasm", "@ferrite/runtime"];

test("requires an explicit execute flag", async () => {
  await assert.rejects(publishNpmRelease({ reportPath: "unused" }), /explicit --execute/);
  assert.deepEqual(parsePublishArgs(["--report", "report.json", "--execute"]), {
    reportPath: "report.json",
    execute: true,
  });
});

test("revalidates and publishes immutable staged bytes in dependency order", async () => {
  await withReleaseReport(async ({ reportPath }) => {
    const calls = [];
    const result = await publishNpmRelease({
      reportPath,
      execute: true,
      sourceIdentity: source,
      runCommand: async (command, args, options) => {
        const bytes = await readFile(args[1]);
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
      assert.deepEqual(args[1], ["--access", "public", "--tag", "next"]) === undefined
    ));
    assert.deepEqual(
      calls.map(({ sha256 }) => sha256),
      result.published.map(({ sha256 }) => sha256),
    );
  });
});

test("stops at the first publication failure", async () => {
  await withReleaseReport(async ({ reportPath }) => {
    let calls = 0;
    await assert.rejects(
      publishNpmRelease({
        reportPath,
        execute: true,
        sourceIdentity: source,
        runCommand: async () => {
          calls += 1;
          if (calls === 2) throw new Error("registry rejected package");
        },
      }),
      /registry rejected package/,
    );
    assert.equal(calls, 2);
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

test("rejects an artifact replaced after planning before immutable staging", async () => {
  await withReleaseReport(async ({ reportPath, root }) => {
    const plan = await prepareNpmRelease({ reportPath, sourceIdentity: source });
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
