#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function fail(message, status = 1) {
  process.stderr.write(`Ferrite local CI: ${message}\n`);
  process.exit(status);
}

function isDeniedName(name) {
  return name.startsWith("BASH_FUNC_") || deniedNames.has(name);
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  fail(`${name} is unavailable`);
}

const importedFunctions = Object.keys(process.env)
  .filter((name) => name.startsWith("BASH_FUNC_"))
  .sort();
if (importedFunctions.length > 0) {
  fail(`disallowed environment variable: ${importedFunctions[0]}`);
}

let extra = [];
if (process.argv.length === 3 && process.argv[2] === "--dry-run") {
  extra = [
    "--dry-run",
    "--format",
    "yaml",
    "--agent-access-token",
    "local-validation-only",
  ];
} else if (process.argv.length !== 2) {
  process.stderr.write("usage: .buildkite/scripts/upload-pipeline.mjs [--dry-run]\n");
  process.exit(64);
}

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !isDeniedName(name)),
);
const buildkiteAgent = findExecutable("buildkite-agent");
const version = spawnSync(buildkiteAgent, ["--version"], {
  encoding: "utf8",
  env: cleanEnvironment,
});
if (version.error || version.status !== 0) {
  fail("could not read the Buildkite Agent version");
}
const versionText = `${version.stdout}${version.stderr}`.trim();
if (!versionText.startsWith("buildkite-agent version 3.127.")) {
  fail(`Buildkite Agent 3.127.x is required, found ${versionText}`);
}

const root = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
const result = spawnSync(
  buildkiteAgent,
  [
    "pipeline",
    "upload",
    "--reject-secrets",
    ...extra,
    join(root, ".buildkite", "pipeline.yml"),
  ],
  {
    cwd: root,
    env: cleanEnvironment,
    stdio: "inherit",
  },
);
if (result.error) {
  fail(`could not start Buildkite Agent: ${result.error.message}`);
}
if (result.signal) {
  fail(`Buildkite Agent terminated by ${result.signal}`);
}
process.exit(result.status ?? 1);
