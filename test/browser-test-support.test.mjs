import assert from "node:assert/strict";
import test from "node:test";

import { requireBrowser } from "./browser-test-support.mjs";

test("browser requirement preserves the default local skip", () => {
  let skipped;
  const available = requireBrowser({ skip(reason) { skipped = reason; } }, "/missing/chrome");
  assert.equal(available, false);
  assert.equal(skipped, "Chrome executable not found at /missing/chrome");
});

test("browser requirement fails closed when proof is required", () => {
  assert.throws(
    () => requireBrowser({ skip() {} }, "/missing/chrome", { required: true }),
    /required browser proof/,
  );
});

test("browser requirement accepts an existing executable", () => {
  assert.equal(requireBrowser({ skip() {} }, process.execPath, { required: true }), true);
});
