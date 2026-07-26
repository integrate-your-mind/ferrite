import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  PORTABLE_RELEASE_PACKAGES,
  parseArgs,
  prepareNpmRelease,
} from "./prepare-npm-release.mjs";
import { createPackageReport } from "./verify-npm-packages.mjs";

const version = "0.1.0-alpha.0";
const source = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const build = {
  provider: "buildkite",
  buildId: "build-123",
  buildNumber: "123",
  jobId: "job-456",
  url: "https://buildkite.example.test/ferrite/builds/123",
};

test("parses the CLI release-plan contract", () => {
  assert.deepEqual(
    parseArgs([
      "--report",
      "dist/npm-packages/npm-package-report.json",
      "--version",
      version,
      "--tag",
      "next",
    ]),
    {
      reportPath: "dist/npm-packages/npm-package-report.json",
      version,
      tag: "next",
    },
  );
});

test("prepares an exact portable alpha release plan in dependency order", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    await writeReport(reportPath, report);
    const plan = await prepareNpmRelease({ reportPath, sourceIdentity: source });

    assert.equal(plan.version, version);
    assert.equal(plan.tag, "next");
    assert.deepEqual(plan.source, source);
    assert.deepEqual(plan.build, build);
    assert.deepEqual(plan.packages.map(({ name }) => name), PORTABLE_RELEASE_PACKAGES);
    const canonicalRoot = await realpath(root);
    assert.ok(plan.packages.every(({ artifact }) => artifact.path.startsWith(canonicalRoot)));
    assert.deepEqual(plan.excluded, [
      {
        name: "@ferrite/node",
        reason: "requires the complete five-target native package set before publication",
      },
    ]);
  });
});

test("rejects a package version that differs from the release candidate", async () => {
  await withReport(async ({ reportPath, report }) => {
    report.packages[1].packedManifest.version = "0.1.0";
    refreshPackageSetDigest(report);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /@ferrite\/protocol-wasm: verified package version must be 0\.1\.0-alpha\.0/,
    );
  });
});

test("rejects a mismatched artifact digest", async () => {
  await withReport(async ({ reportPath, report }) => {
    report.packages[0].publishArtifact.sha256 = "0".repeat(64);
    refreshPackageSetDigest(report);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /@ferrite\/protocol: publish artifact digest does not match/,
    );
  });
});

test("rejects an in-root artifact path outside the tarball directory", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    const artifact = report.packages[0].publishArtifact;
    await writeFile(join(root, artifact.filename), await readFile(join(root, artifact.path)));
    artifact.path = artifact.filename;
    refreshPackageSetDigest(report);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /@ferrite\/protocol: publish artifact path is unsafe/,
    );
  });
});

test("rejects a publish artifact symlink that escapes the report directory", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    const outside = join(dirname(root), `${basename(root)}-outside.tgz`);
    try {
      await writeFile(outside, "outside");
      const artifactPath = join(root, report.packages[0].publishArtifact.path);
      await rm(artifactPath);
      await symlink(outside, artifactPath);
      report.packages[0].publishArtifact.size = 7;
      report.packages[0].publishArtifact.sha256 = createHash("sha256").update("outside").digest("hex");
      refreshPackageSetDigest(report);
      await writeReport(reportPath, report);
      await assert.rejects(
        prepareNpmRelease({ reportPath, sourceIdentity: source }),
        /@ferrite\/protocol: publish artifact resolves outside/,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("rejects a forged self-consistent report containing non-gzip artifacts", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    for (const entry of report.packages) {
      const bytes = Buffer.from(`${entry.name} forged bytes\n`);
      await writeFile(join(root, entry.publishArtifact.path), bytes);
      entry.publishArtifact.size = bytes.byteLength;
      entry.publishArtifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    refreshPackageSetDigest(report);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /not a valid gzip archive/,
    );
  });
});

test("rejects a report bound to a stale source commit or tree", async () => {
  await withReport(async ({ reportPath, report }) => {
    report.source.commit = "c".repeat(40);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /source commit\/tree does not match/,
    );
  });
});

test("rejects a report without exact Buildkite package proof", async () => {
  await withReport(async ({ reportPath, report }) => {
    report.build = { provider: "local" };
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath, sourceIdentity: source }),
      /requires an exact Buildkite package report/,
    );
  });
});

async function withReport(callback) {
  const root = await mkdtemp(join(tmpdir(), "ferrite-release-plan-"));
  const tarballDir = join(root, "tarballs");
  const reportPath = join(root, "npm-package-report.json");
  try {
    await mkdir(tarballDir);
    const packages = [];
    for (const name of PORTABLE_RELEASE_PACKAGES) {
      const filename = `${name.replace("@ferrite/", "")}-${version}.tgz`;
      const packedManifest = {
        name,
        version,
        publishConfig: { access: "public" },
        ...(name === "@ferrite/protocol"
          ? {}
          : { dependencies: { "@ferrite/protocol": version } }),
      };
      const files = ["dist/index.js", "package.json"];
      const bytes = npmTarball({
        "package/package.json": `${JSON.stringify(packedManifest)}\n`,
        "package/dist/index.js": `export const packageName = ${JSON.stringify(name)};\n`,
      });
      await writeFile(join(tarballDir, filename), bytes);
      packages.push({
        name,
        version,
        files,
        packedManifest,
        publishArtifact: {
          path: `tarballs/${filename}`,
          filename,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    }
    const report = createPackageReport({ packages, source, build });
    await callback({ root, reportPath, report });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeReport(reportPath, report) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
}

function refreshPackageSetDigest(report) {
  report.packageSetSha256 = createPackageReport({
    packages: report.packages,
    source: report.source,
    build: report.build,
  }).packageSetSha256;
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
