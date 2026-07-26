import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import {
  PORTABLE_RELEASE_PACKAGES,
  parseArgs,
  prepareNpmRelease,
} from "./prepare-npm-release.mjs";

const version = "0.1.0-alpha.0";

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
    const plan = await prepareNpmRelease({ reportPath });

    assert.equal(plan.version, version);
    assert.equal(plan.tag, "next");
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
    report[1].packedManifest.version = "0.1.0";
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath }),
      /@ferrite\/protocol-wasm: verified package version must be 0\.1\.0-alpha\.0/,
    );
  });
});

test("rejects a mismatched artifact digest", async () => {
  await withReport(async ({ reportPath, report }) => {
    report[0].publishArtifact.sha256 = "0".repeat(64);
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath }),
      /@ferrite\/protocol: publish artifact digest does not match/,
    );
  });
});

test("rejects an in-root artifact path outside the tarball directory", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    const artifact = report[0].publishArtifact;
    await writeFile(join(root, artifact.filename), await readFile(join(root, artifact.path)));
    artifact.path = artifact.filename;
    await writeReport(reportPath, report);
    await assert.rejects(
      prepareNpmRelease({ reportPath }),
      /@ferrite\/protocol: publish artifact path is unsafe/,
    );
  });
});

test("rejects a publish artifact symlink that escapes the report directory", async () => {
  await withReport(async ({ root, reportPath, report }) => {
    const outside = join(dirname(root), `${basename(root)}-outside.tgz`);
    try {
      await writeFile(outside, "outside");
      const artifactPath = join(root, report[0].publishArtifact.path);
      await rm(artifactPath);
      await symlink(outside, artifactPath);
      report[0].publishArtifact.size = 7;
      report[0].publishArtifact.sha256 = createHash("sha256").update("outside").digest("hex");
      await writeReport(reportPath, report);
      await assert.rejects(
        prepareNpmRelease({ reportPath }),
        /@ferrite\/protocol: publish artifact resolves outside/,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

async function withReport(callback) {
  const root = await mkdtemp(join(tmpdir(), "ferrite-release-plan-"));
  const tarballDir = join(root, "tarballs");
  const reportPath = join(root, "npm-package-report.json");
  try {
    await mkdir(tarballDir);
    const report = [];
    for (const name of PORTABLE_RELEASE_PACKAGES) {
      const filename = `${name.replace("@ferrite/", "")}-${version}.tgz`;
      const bytes = Buffer.from(`${name} exact artifact\n`);
      await writeFile(join(tarballDir, filename), bytes);
      report.push({
        name,
        version,
        packedManifest: {
          name,
          version,
          publishConfig: { access: "public" },
          ...(name === "@ferrite/protocol"
            ? {}
            : { dependencies: { "@ferrite/protocol": version } }),
        },
        publishArtifact: {
          path: `tarballs/${filename}`,
          filename,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    }
    await callback({ root, reportPath, report });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeReport(reportPath, report) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
}
