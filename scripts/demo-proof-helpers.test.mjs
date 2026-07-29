import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  browserExecutableCandidates,
  cargoTargetRoot,
  expectedArtifactFiles,
  launchVerifiedBrowser,
  listArtifactFiles,
} from "./demo-proof-helpers.mjs";

test("demo proof resolves default, relative, and absolute Cargo target roots", () => {
  assert.equal(
    cargoTargetRoot({
      cwd: "/workspace",
      env: {},
      repoRoot: "/workspace/ferrite",
    }),
    "/workspace/ferrite/target",
  );
  assert.equal(
    cargoTargetRoot({
      cwd: "/workspace/ferrite",
      env: { CARGO_TARGET_DIR: ".ferrite/isolated-target" },
      repoRoot: "/workspace/ferrite",
    }),
    "/workspace/ferrite/.ferrite/isolated-target",
  );
  assert.equal(
    cargoTargetRoot({
      cwd: "/workspace/ferrite",
      env: { CARGO_TARGET_DIR: "/tmp/ferrite-target" },
      repoRoot: "/workspace/ferrite",
    }),
    "/tmp/ferrite-target",
  );
});

test("configured browser path is exclusive and whitespace is trimmed", () => {
  assert.deepEqual(
    browserExecutableCandidates({
      env: { FERRITE_BROWSER_EXECUTABLE: "  /custom/chromium  " },
      platform: "linux",
      playwrightExecutablePath: "/cache/chromium",
    }),
    { candidates: ["/custom/chromium"], configured: true },
  );
});

test("browser candidates are ordered, portable, and deduplicated", () => {
  assert.deepEqual(
    browserExecutableCandidates({
      env: {},
      platform: "linux",
      playwrightExecutablePath: "/usr/bin/chromium",
    }),
    {
      candidates: [
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
      ],
      configured: false,
    },
  );
});

test("browser launch skips a stale cache entry and uses a working fallback", async () => {
  const launches = [];
  const browser = { version: () => "143.0.0.0", close: async () => {} };
  const result = await launchVerifiedBrowser({
    chromium: {
      launch: async ({ executablePath }) => {
        launches.push(executablePath);
        if (executablePath === "/cache/chromium") throw new Error("missing framework");
        return browser;
      },
    },
    candidates: ["/cache/chromium", "/system/chromium"],
    platform: "linux",
    statFile: async () => ({ isFile: () => true }),
    accessFile: async () => {},
  });

  assert.deepEqual(launches, ["/cache/chromium", "/system/chromium"]);
  assert.equal(result.browser, browser);
  assert.equal(result.executablePath, "/system/chromium");
  assert.equal(result.version, "143.0.0.0");
});

test("configured browser failure does not silently select another binary", async () => {
  const launches = [];
  await assert.rejects(
    launchVerifiedBrowser({
      chromium: {
        launch: async ({ executablePath }) => {
          launches.push(executablePath);
          throw new Error("incompatible browser");
        },
      },
      candidates: ["/configured/chromium", "/fallback/chromium"],
      configured: true,
      platform: "linux",
      statFile: async () => ({ isFile: () => true }),
      accessFile: async () => {},
    }),
    /FERRITE_BROWSER_EXECUTABLE did not identify a launchable Chromium browser/,
  );
  assert.deepEqual(launches, ["/configured/chromium"]);
});

test("artifact file inventory is sorted and includes only regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-demo-files-"));
  try {
    await mkdir(join(root, "server"));
    await writeFile(join(root, "z.txt"), "z");
    await writeFile(join(root, "server", "route.mjs"), "route");
    assert.deepEqual(await listArtifactFiles(root), ["server/route.mjs", "z.txt"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("artifact inventory rejects a symlink instead of trusting its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-demo-symlink-"));
  try {
    await writeFile(join(root, "target.txt"), "target");
    try {
      await symlink(join(root, "target.txt"), join(root, "linked.txt"));
    } catch (error) {
      t.skip(`symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await assert.rejects(listArtifactFiles(root), /unsupported entry: linked.txt/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("expected artifact inventory includes both manifests and declared files", () => {
  assert.deepEqual(
    expectedArtifactFiles([{ path: "server/route.mjs" }, { path: "index.html" }]),
    ["ferrite-build.json", "ferrite-server.json", "index.html", "server/route.mjs"],
  );
});
