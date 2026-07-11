import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/native-prebuild-dry-run.yml", import.meta.url);

test("native prebuild workflow uses supported architecture-specific macOS runners", async () => {
  const source = await readFile(workflowUrl, "utf8");

  assert.doesNotMatch(source, /runner: macos-13(?:\s|$)/);
  assert.match(
    source,
    /package: "@ferrite\/node-darwin-arm64"[\s\S]{0,160}runner: macos-latest/,
  );
  assert.match(
    source,
    /package: "@ferrite\/node-darwin-x64"[\s\S]{0,160}runner: macos-15-intel/,
  );
});
