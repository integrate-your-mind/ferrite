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

function pipelineStep(source, key) {
  const marker = `    key: "${key}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `pipeline does not define ${key}`);
  const end = source.indexOf("\n  - label:", start);
  return source.slice(start, end === -1 ? source.length : end);
}

test("Buildkite pipeline runs dependency-ordered clean-checkout gates on the dedicated local queue", async () => {
  const source = await readFile(pipelineUrl, "utf8");
  const expectedKeys = [
    "ferrite-verify",
    "ferrite-packages",
    "ferrite-coverage-rust",
    "ferrite-coverage-js",
    "ferrite-native",
    "ferrite-nginx",
  ];

  for (const [key, mode, dependency, timeout] of [
    ["ferrite-verify", "verify", null, 30],
    ["ferrite-packages", "packages", "ferrite-verify", 30],
    ["ferrite-coverage-rust", "coverage-rust", "ferrite-packages", 45],
    ["ferrite-coverage-js", "coverage-js", "ferrite-coverage-rust", 30],
    ["ferrite-native", "native", "ferrite-coverage-js", 30],
    ["ferrite-nginx", "nginx", "ferrite-native", 45],
  ]) {
    const step = pipelineStep(source, key);
    assert.match(
      step,
      new RegExp(`command: "\\./\\.buildkite/scripts/ci\\.sh ${mode}"`),
    );
    if (dependency) {
      assert.match(step, new RegExp(`depends_on: "${dependency}"`));
    } else {
      assert.doesNotMatch(step, /depends_on:/);
    }
    assert.match(step, new RegExp(`timeout_in_minutes: ${timeout}`));
    assert.match(step, /queue: "ferrite-local"/);
    assert.match(step, /project: "ferrite"/);
    assert.match(step, /os: "darwin"/);
    assert.match(step, /arch: "arm64"/);
  }
  assert.deepEqual(
    [...source.matchAll(/^\s{4}key: "([^"]+)"$/gm)].map(([, key]) => key),
    expectedKeys,
    "the pipeline must not gain unreviewed steps outside the six validated gates",
  );
  assert.equal(
    [...source.matchAll(/^\s{2}- label:/gm)].length,
    expectedKeys.length,
    "every pipeline step must be represented by a validated key",
  );
  assert.doesNotMatch(source, /command: "\.\/\.buildkite\/scripts\/ci\.sh all"/);
  assert.match(source, /dist\/ci\/\*\*\/\*/);
  assert.doesNotMatch(source, /plugins:|deploy|publish|release/);
});

test("bounded agent uptime covers the complete serial job timeout envelope", async () => {
  const [pipeline, config] = await Promise.all([
    readFile(pipelineUrl, "utf8"),
    readFile(configUrl, "utf8"),
  ]);
  const timeouts = [...pipeline.matchAll(/timeout_in_minutes: (\d+)/g)].map(
    ([, value]) => Number(value),
  );
  const uptime = Number(
    config.match(/disconnect-after-uptime=(\d+)/)?.[1] ?? Number.NaN,
  );
  const pipelineUploadTimeoutSeconds = 10 * 60;

  assert.equal(timeouts.length, 6);
  assert.ok(Number.isFinite(uptime));
  assert.ok(
    uptime >=
      pipelineUploadTimeoutSeconds +
        timeouts.reduce((total, minutes) => total + minutes * 60, 0),
    "agent uptime must cover pipeline upload plus every serial job timeout",
  );
});

test("local CI retains the host-executable validation gate categories", async () => {
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
    "npm --prefix website run typecheck",
    "npm --prefix website audit --omit=dev --audit-level=high",
    "./.buildkite/scripts/upload-pipeline.sh --dry-run",
    "gitleaks git --no-banner --redact",
  ]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /command -v pnpm/);
  assert.match(source, /pnpm_version="\$\(pnpm --version\)"/);
  assert.match(source, /rustup target list --toolchain stable --installed/);
  assert.match(source, /wasm32-unknown-unknown/);
  assert.match(source, /export CARGO_BUILD_JOBS=1/);
  assert.match(source, /export CARGO_INCREMENTAL=0/);
  assert.match(source, /export CARGO_PROFILE_DEV_DEBUG=0/);
  assert.match(source, /export CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off/);
  assert.match(source, /MIN_FREE_KIB=20971520/);
  assert.match(source, /\/bin\/df -Pk "\$\{ROOT\}"/);
  assert.match(source, /storage admission requires at least/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=all/);
  assert.doesNotMatch(source, /git diff --quiet/);
  assert.ok(
    source.indexOf("/bin/df -Pk") < source.indexOf('mkdir -p "${REPORT_DIR}"'),
    "storage admission must run before CI creates report output",
  );
  assert.match(
    source,
    /run_gate coverage-rust-prerequisites pnpm --filter @ferrite\/runtime build/,
  );
  assert.match(source, /run_gate coverage-rust rustup run stable cargo llvm-cov/);
  const coverageRust = source.slice(
    source.indexOf("coverage_rust()"),
    source.indexOf("coverage_js()"),
  );
  assert.ok(
    coverageRust.indexOf("coverage-rust-prerequisites") <
      coverageRust.indexOf("run_gate coverage-rust rustup"),
    "runtime prerequisites must be built before Rust coverage exercises the client bundler",
  );
  assert.match(
    source,
    /run_gate coverage-runtime-prerequisites pnpm --filter @ferrite\/runtime build/,
  );
  assert.match(
    source,
    /run_gate coverage-native-prerequisites pnpm --filter @ferrite\/node build/,
  );
  assert.match(source, /run_gate coverage-prerequisites-clean cargo clean/);
  assert.doesNotMatch(source, /run_gate coverage-prerequisites pnpm build/);
  const coverageJs = source.slice(
    source.indexOf("coverage_js()"),
    source.indexOf("native_current_host()"),
  );
  for (const [first, second] of [
    ["coverage-runtime-prerequisites", "coverage-native-prerequisites"],
    ["coverage-native-prerequisites", "coverage-prerequisites-clean"],
    ["coverage-prerequisites-clean", "coverage-runtime bash"],
    ["coverage-runtime bash", "coverage-native bash"],
  ]) {
    assert.ok(
      coverageJs.indexOf(first) < coverageJs.indexOf(second),
      `${first} must run before ${second}`,
    );
  }
  assert.doesNotMatch(source, /coverage-rust env RUSTC=/);
  assert.doesNotMatch(source, /gitleaks git [^\n]*--log-opts=-1/);
  assert.doesNotMatch(source, /corepack pnpm/);
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
  assert.match(source, /disconnect-after-uptime=14400/);
  assert.match(source, /enable-environment-variable-allowlist=true/);
  assert.match(source, /allowed-environment-variables=/);
  assert.doesNotMatch(source, /BASH_ENV|GIT_SSH_COMMAND|NODE_OPTIONS|RUSTFLAGS/);
  assert.doesNotMatch(source, /no-command-eval=true|disconnect-after-job=true/);
  assert.doesNotMatch(source, /^token\s*=/m);
});

test("external environment hook accepts only the approved Ferrite commit", async () => {
  const source = await readFile(environmentHookUrl, "utf8");
  const approved = "a".repeat(40);
  const base = {
    BUILDKITE_REPO: "git@github.com:integrate-your-mind/ferrite.git",
    BUILDKITE_COMMIT: approved,
    FERRITE_BUILDKITE_APPROVED_COMMIT: approved,
    BUILDKITE_PULL_REQUEST_REPO: "https://github.com/integrate-your-mind/ferrite",
  };

  assert.equal(runHook(environmentHookUrl, base).status, 0);
  assert.match(source, /\$\{CARGO_HOME:-\$\{HOME\}\/\.cargo\}\/bin/);
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
  for (const mode of [
    "verify",
    "packages",
    "coverage-rust",
    "coverage-js",
    "native",
    "nginx",
  ]) {
    assert.equal(
      runHook(preCommandHookUrl, {
        BUILDKITE_COMMAND: `./.buildkite/scripts/ci.sh ${mode}`,
      }).status,
      0,
    );
  }
  assert.notEqual(
    runHook(preCommandHookUrl, {
      BUILDKITE_COMMAND: "./.buildkite/scripts/ci.sh coverage",
    }).status,
    0,
  );
  assert.notEqual(
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
  for (const name of [
    "BASH_ENV",
    "CDPATH",
    "ENV",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
  ]) {
    assert.match(source, new RegExp(name));
  }
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
