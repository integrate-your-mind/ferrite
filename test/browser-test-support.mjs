import { existsSync } from "node:fs";

/** Keep local browser tests convenient while allowing CI proof to fail closed. */
export function requireBrowser(testContext, executable, {
  required = process.env.FERRITE_REQUIRE_BROWSER === "1",
} = {}) {
  if (existsSync(executable)) return true;
  const message = `Chrome executable not found at ${executable}`;
  if (required) {
    throw new Error(`${message}; set FERRITE_BROWSER_EXECUTABLE or install Chrome before required browser proof`);
  }
  testContext.skip(message);
  return false;
}
