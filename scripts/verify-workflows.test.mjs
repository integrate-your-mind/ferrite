import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/native-prebuild-dry-run.yml", import.meta.url);
const verifyWorkflowUrl = new URL("../.github/workflows/verify.yml", import.meta.url);

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

test("verify workflow runs the self-contained pinned-nginx stack", async () => {
  const source = await readFile(verifyWorkflowUrl, "utf8");

  assert.match(source, /^  nginx-stack:$/m);
  assert.match(source, /name: Pinned nginx integration/);
  assert.match(source, /timeout-minutes: 45/);
  assert.match(source, /run: node scripts\/verify-nginx-stack\.mjs/);
});
