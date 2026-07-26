import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const source = join(fixtures, "react-basic", "src", "App.tsx");
  const before = await readFile(source, "utf8");
  try {
    await run(["--project", join(fixtures, "react-basic"), "--output", output]);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.mode, "read-only-dry-run");
    assert.equal(report.dryRunPlan.length, 5);
    assert.equal(await readFile(source, "utf8"), before);
    assert.deepEqual(await scanProject(join(fixtures, "react-basic")), await scanProject(join(fixtures, "react-basic")));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
