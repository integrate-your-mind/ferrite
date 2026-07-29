#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowedModes = new Set([
  "preflight",
  "verify",
  "packages",
  "coverage",
  "coverage-rust",
  "coverage-js",
  "native",
  "nginx",
  "all",
]);
const deniedNames = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "BASH_COMPAT",
  "BASH_LOADABLES_PATH",
  "BASH_XTRACEFD",
  "CDPATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "FERRITE_CI_REPORT_DIR",
  "GIT_ASKPASS",
  "GIT_CONFIG_COUNT",
  "GIT_SSH_COMMAND",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "PS4",
  "PYTHONPATH",
  "RUBYOPT",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
]);

function fail(message) {
  process.stderr.write(`Ferrite local CI: ${message}\n`);
  process.exit(1);
}

function isDeniedName(name) {
  return name.startsWith("BASH_FUNC_") || deniedNames.has(name);
}

const mode = process.argv[2] ?? "";
if (process.argv.length !== 3 || !allowedModes.has(mode)) {
  process.stderr.write(
    "usage: .buildkite/scripts/ci.mjs " +
      "{preflight|verify|packages|coverage|coverage-rust|coverage-js|native|nginx|all}\n",
  );
  process.exit(64);
}

const importedFunctions = Object.keys(process.env)
  .filter((name) => name.startsWith("BASH_FUNC_"))
  .sort();
if (importedFunctions.length > 0) {
  fail(`disallowed environment variable: ${importedFunctions[0]}`);
}

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !isDeniedName(name)),
);
const script = join(dirname(fileURLToPath(import.meta.url)), "ci-internal.sh");
const result = spawnSync("/bin/bash", [script, mode], {
  cwd: process.cwd(),
  env: cleanEnvironment,
  stdio: "inherit",
});

if (result.error) {
  fail(`could not start the internal CI runner: ${result.error.message}`);
}
if (result.signal) {
  fail(`internal CI runner terminated by ${result.signal}`);
}
process.exit(result.status ?? 1);
