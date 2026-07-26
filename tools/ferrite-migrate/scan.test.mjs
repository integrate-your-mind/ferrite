import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { scanProject, run } from "./scan.mjs";

const fixtures = resolve("tools/ferrite-migrate/fixtures");

test("reports a structural React candidate without promising automatic migration", async () => {
  const report = await scanProject(join(fixtures, "react-basic"));
  assert.equal(report.project.framework, "react");
  assert.equal(report.compatibility.tier, "TIER_1_STRUCTURAL");
  assert.equal(report.compatibility.automaticMigration, false);
  assert.deepEqual(report.manualBlockers, []);
});

test("annotates Next.js manual blockers conservatively", async () => {
  const report = await scanProject(join(fixtures, "next-manual"));
  assert.equal(report.project.framework, "next");
  assert.equal(report.compatibility.tier, "TIER_3_MANUAL_REVIEW");
  assert.deepEqual(new Set(report.manualBlockers.map((blocker) => blocker.code)), new Set([
    "NEXT_API_ROUTES", "NEXT_CONFIG", "NEXT_DATA_FUNCTION", "NEXT_MIDDLEWARE",
  ]));
});

test("fails clearly for a missing or non-project target", async () => {
  await assert.rejects(() => scanProject(join(fixtures, "missing")), /requires a readable package\.json/);
});

test("writes a deterministic dry-run report without touching the target", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "ferrite-migrate-test-"));
  const output = join(outputDirectory, "plan.json");
  const project = join(fixtures, "react-basic");
  const before = await snapshotTree(project);
  try {
    await run(["--project", project, "--output", output]);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.mode, "read-only-dry-run");
    assert.equal(report.dryRunPlan.length, 5);
    assert.deepEqual(await snapshotTree(project), before);
    assert.deepEqual(await scanProject(project), await scanProject(project));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects direct and symlinked output paths inside the scanned project without changing its tree", async () => {
  const project = join(fixtures, "react-basic");
  const before = await snapshotTree(project);
  const aliasParent = await mkdtemp(join(tmpdir(), "ferrite-migrate-alias-"));
  const alias = join(aliasParent, "project-alias");
  try {
    await symlink(project, alias);
    await assert.rejects(
      () => run(["--project", project, "--output", join(project, "plan.json")]),
      /Refusing to write --output inside scanned project/,
    );
    await assert.rejects(
      () => run(["--project", project, "--output", join(alias, "nested", "plan.json")]),
      /Refusing to write --output inside scanned project/,
    );
    assert.deepEqual(await snapshotTree(project), before);
  } finally {
    await rm(aliasParent, { recursive: true, force: true });
  }
});

async function snapshotTree(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshots = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return snapshotTree(root, path);
    return [[path.slice(root.length + 1), await readFile(path, "utf8")]];
  }));
  return snapshots.flat().sort(([left], [right]) => left.localeCompare(right));
}
