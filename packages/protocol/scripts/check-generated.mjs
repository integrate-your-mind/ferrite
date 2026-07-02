import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const sourcePath = join(packageRoot, "src/index.ts");

const [{ stdout }, source] = await Promise.all([
  execFileAsync(
    "cargo",
    ["run", "--quiet", "-p", "ferrite-protocol", "--bin", "ferrite-protocol-codegen"],
    {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
    },
  ),
  readFile(sourcePath, "utf8"),
]);

assert.equal(
  source,
  stdout,
  "packages/protocol/src/index.ts must match Rust ferrite-protocol codegen output.",
);
