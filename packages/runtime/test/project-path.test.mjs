import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isPathInsideRoot, portableCanonicalPath } from "../bin/project-path.mjs";

test("project path containment rejects parent, cross-drive, and UNC escapes", () => {
  assert.equal(isPathInsideRoot("/project", "/project/app/page.tsx", posix), true);
  assert.equal(isPathInsideRoot("/project", "/project", posix), false);
  assert.equal(isPathInsideRoot("/project", "/project-other/page.tsx", posix), false);
  assert.equal(isPathInsideRoot("/project", "/outside/page.tsx", posix), false);

  assert.equal(isPathInsideRoot("C:\\project", "C:\\project\\app\\page.tsx", win32), true);
  assert.equal(isPathInsideRoot("C:\\project", "D:\\secret.ts", win32), false);
  assert.equal(isPathInsideRoot("C:\\project", "\\\\server\\share\\secret.ts", win32), false);
});

test("canonical path normalization aligns Windows drive and UNC forms", () => {
  assert.equal(portableCanonicalPath("C:\\workspace\\asset.json"), "C:/workspace/asset.json");
  assert.equal(portableCanonicalPath("\\\\?\\C:\\workspace\\asset.json"), "C:/workspace/asset.json");
  assert.equal(portableCanonicalPath("\\\\server\\share\\asset.json"), "//server/share/asset.json");
  assert.equal(portableCanonicalPath("\\\\?\\UNC\\server\\share\\asset.json"), "//server/share/asset.json");
  assert.equal(portableCanonicalPath("\\\\?\\unc\\server\\share\\asset.json"), "//server/share/asset.json");
});
