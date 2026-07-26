import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const pipelineUrl = new URL("../.buildkite/pipeline.yml", import.meta.url);
const ciUrl = new URL("../.buildkite/scripts/ci.sh", import.meta.url);
const uploadUrl = new URL("../.buildkite/scripts/upload-pipeline.sh", import.meta.url);
const configUrl = new URL("../deploy/buildkite/ferrite-agent.cfg.example", import.meta.url);
const environmentHookUrl = new URL("../deploy/buildkite/hooks/environment", import.meta.url);
const preCommandHookUrl = new URL("../deploy/buildkite/hooks/pre-command", import.meta.url);
const workflowsUrl = new URL("../.github/workflows", import.meta.url);

function runHook(url, env) {
  return spawnSync(url.pathname, [], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ...env,
    },
  });
}

test("Buildkite pipeline runs one bounded command on the dedicated local queue", async () => {
  const source = await readFile(pipelineUrl, "utf8");

  assert.match(source, /command: "\.\/\.buildkite\/scripts\/ci\.sh all"/);
  assert.match(source, /queue: "ferrite-local"/);
  assert.match(source, /project: "ferrite"/);
  assert.match(source, /os: "darwin"/);
  assert.match(source, /arch: "arm64"/);
  assert.match(source, /timeout_in_minutes: 120/);
  assert.match(source, /dist\/ci\/\*\*\/\*/);
  assert.doesNotMatch(source, /plugins:|deploy|publish|release/);
});

test("local CI preserves build, test, package, coverage, native, and nginx gates", async () => {
  const source = await readFile(ciUrl, "utf8");

  for (const expected of [
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm test",
    "pnpm release:verify:npm",
    "pnpm release:verify:cargo",
    "cargo llvm-cov",
    "--experimental-test-coverage",
    "prebuild:package",
    "prebuild:verify",
    "pnpm test:nginx:stack",
    "npm --prefix website test",
    "npm --prefix website audit --omit=dev --audit-level=high",
    "./.buildkite/scripts/upload-pipeline.sh --dry-run",
  ]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /\bnpm publish\b|\bcargo publish\b|\bdeploy\b/);
});

test("pipeline upload rejects embedded secrets", async () => {
  const source = await readFile(uploadUrl, "utf8");

  assert.match(source, /pipeline upload/);
  assert.match(source, /--reject-secrets/);
  assert.match(source, /Buildkite Agent 3\.127\.x is required/);
  assert.match(source, /--dry-run --format yaml --agent-access-token local-validation-only/);
  assert.match(source, /\.buildkite\/pipeline\.yml/);
});

test("dedicated agent configuration disables plugins and local hooks", async () => {
  const source = await readFile(configUrl, "utf8");

  assert.match(source, /queue=ferrite-local/);
  assert.match(source, /project=ferrite/);
  assert.match(source, /no-plugins=true/);
  assert.match(source, /no-local-hooks=true/);
  assert.match(source, /git-clean-flags="-ffxdq"/);
  assert.match(source, /disconnect-after-idle-timeout=300/);
  assert.match(source, /disconnect-after-uptime=8100/);
  assert.doesNotMatch(source, /no-command-eval=true|disconnect-after-job=true/);
  assert.doesNotMatch(source, /^token\s*=/m);
});

test("external environment hook accepts only the approved Ferrite commit", async () => {
  const approved = "a".repeat(40);
  const base = {
    BUILDKITE_REPO: "git@github.com:integrate-your-mind/ferrite.git",
    BUILDKITE_COMMIT: approved,
    FERRITE_BUILDKITE_APPROVED_COMMIT: approved,
    BUILDKITE_PULL_REQUEST_REPO: "https://github.com/integrate-your-mind/ferrite",
  };

  assert.equal(runHook(environmentHookUrl, base).status, 0);
  assert.notEqual(
    runHook(environmentHookUrl, {
      ...base,
      BUILDKITE_COMMIT: "b".repeat(40),
    }).status,
    0,
  );
  assert.notEqual(
    runHook(environmentHookUrl, {
      ...base,
      BUILDKITE_REPO: "git@github.com:someone/other.git",
    }).status,
    0,
  );
  assert.notEqual(
    runHook(environmentHookUrl, {
      ...base,
      BUILDKITE_PULL_REQUEST_REPO: "https://github.com/someone/fork",
    }).status,
    0,
  );
  assert.notEqual(
    runHook(environmentHookUrl, {
      ...base,
      NPM_TOKEN: "fixture-value",
    }).status,
    0,
  );
});

test("external command hook rejects arbitrary commands", async () => {
  assert.equal(
    runHook(preCommandHookUrl, {
      BUILDKITE_COMMAND: "./.buildkite/scripts/upload-pipeline.sh",
    }).status,
    0,
  );
  assert.equal(
    runHook(preCommandHookUrl, {
      BUILDKITE_COMMAND: "./.buildkite/scripts/ci.sh all",
    }).status,
    0,
  );
  assert.notEqual(
    runHook(preCommandHookUrl, {
      BUILDKITE_COMMAND: "env",
    }).status,
    0,
  );

  const source = await readFile(preCommandHookUrl, "utf8");
  assert.match(source, /unset SSH_AUTH_SOCK GIT_ASKPASS SSH_ASKPASS/);
});

test("CI script rejects unknown modes before running project commands", () => {
  const result = spawnSync(ciUrl.pathname, ["unknown"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage:/);
});

test("pipeline uploader rejects unexpected arguments before contacting Buildkite", () => {
  const result = spawnSync(uploadUrl.pathname, ["unexpected"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
  });

  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage:/);
});

test("GitHub Actions workflows are removed from the active CI path", async () => {
  const entries = await readdir(workflowsUrl).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  assert.deepEqual(entries, []);
});

test("Buildkite scripts and hook templates are executable", async () => {
  for (const url of [ciUrl, uploadUrl, environmentHookUrl, preCommandHookUrl]) {
    await access(url);
    const metadata = await stat(url);
    assert.notEqual(metadata.mode & 0o111, 0);
  }
});
