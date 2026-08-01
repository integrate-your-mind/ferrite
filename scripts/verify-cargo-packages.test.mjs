import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);
const cratesUrl = new URL("crates/", rootUrl);
const packageUrl = new URL("package.json", rootUrl);

test("workspace path dependencies exact-pin the unpublished Ferrite version", async () => {
  const crateDirectories = await readdir(cratesUrl, { withFileTypes: true });
  const internalDependencies = [];

  for (const directory of crateDirectories) {
    if (!directory.isDirectory()) continue;
    const manifest = await readFile(new URL(`${directory.name}/Cargo.toml`, cratesUrl), "utf8");
    for (const line of manifest.split("\n")) {
      if (!/^ferrite-[a-z-]+\s*=/.test(line) || !line.includes("path =")) continue;
      const dependency = line.match(/^(ferrite-[a-z-]+)\s*=/)?.[1];
      const version = line.match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
      assert.ok(dependency, `could not parse internal dependency from ${line}`);
      assert.equal(
        version,
        "=0.1.0",
        `${directory.name} must exact-pin ${dependency} so packaging cannot resolve an unrelated registry version`,
      );
      internalDependencies.push(`${directory.name}:${dependency}`);
    }
  }

  assert.equal(
    internalDependencies.length,
    23,
    "update the internal dependency inventory when adding or removing exact-pinned workspace edges",
  );
});

test("Cargo packaging verifies clean archives with the locked dependency graph", async () => {
  const rootPackage = JSON.parse(await readFile(packageUrl, "utf8"));
  const command = rootPackage.scripts["release:verify:cargo"];

  assert.equal(command, "cargo package --workspace --locked");
  assert.doesNotMatch(command, /--allow-dirty/);
  assert.doesNotMatch(command, /--no-verify/);
});
