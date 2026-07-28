import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const pipelineUrl = new URL("../.buildkite/pipeline.yml", import.meta.url);
const ciUrl = new URL("../.buildkite/scripts/ci.sh", import.meta.url);
const uploadUrl = new URL("../.buildkite/scripts/upload-pipeline.sh", import.meta.url);
const configUrl = new URL("../deploy/buildkite/ferrite-agent.cfg.example", import.meta.url);
const environmentHookUrl = new URL("../deploy/buildkite/hooks/environment", import.meta.url);
const preCommandHookUrl = new URL("../deploy/buildkite/hooks/pre-command", import.meta.url);
const preExitHookUrl = new URL("../deploy/buildkite/hooks/pre-exit", import.meta.url);
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

function runSourcedShell(url, script, env = {}) {
  return spawnSync("/bin/bash", ["-c", `source ${url.pathname}; ${script}`], {
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
    "pnpm --dir website install --ignore-workspace --frozen-lockfile",
    "pnpm --dir website lint",
    "pnpm --dir website typecheck",
    "pnpm --dir website build",
    "pnpm --dir website test",
    "pnpm --dir website package:sites",
    "pnpm --dir website audit --prod --audit-level high",
    "./.buildkite/scripts/upload-pipeline.sh --dry-run",
    "gitleaks git --no-banner --redact",
  ]) {
    assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(source, /npm --prefix website/);
  assert.match(source, /command -v pnpm/);
  assert.match(source, /pnpm_version="\$\(pnpm --version\)"/);
  assert.match(
    source,
    /rustup target list --toolchain "\$\{RUST_TOOLCHAIN\}" --installed/,
  );
  assert.match(source, /wasm32-unknown-unknown/);
  assert.match(source, /export CARGO_BUILD_JOBS=1/);
  assert.match(source, /export CARGO_INCREMENTAL=0/);
  assert.match(source, /export CARGO_PROFILE_DEV_DEBUG=0/);
  assert.match(source, /export CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off/);
  assert.doesNotMatch(source, /CARGOFLAGS=--locked/);
  assert.match(source, /cargo llvm-cov --locked/);
  assert.match(source, /cargo audit --deny warnings/);
  assert.match(source, /command -v cargo-audit/);
  assert.match(source, /command -v cargo-llvm-cov/);
  assert.match(source, /RUST_TOOLCHAIN="1\.95\.0"/);
  assert.match(source, /activate_rust_toolchain/);
  assert.match(source, /rustup which --toolchain "\$\{RUST_TOOLCHAIN\}"/);
  for (const tool of [
    "cargo",
    "rustc",
    "cargo-clippy",
    "clippy-driver",
    "rustfmt",
    "rustdoc",
  ]) {
    assert.match(source, new RegExp(`command -v "\\$\\{tool\\}"`));
  }
  assert.match(source, /cargo_path=/);
  assert.match(source, /rustc_path=/);
  assert.match(source, /cargo_clippy_path=/);
  assert.match(source, /clippy_driver_path=/);
  assert.match(source, /cargo_verbose=/);
  assert.match(source, /rust_verbose=/);
  assert.match(source, /start_cargo_lock_sha/);
  assert.match(source, /end_cargo_lock_sha/);
  assert.match(source, /child_status="\$\?"/);
  assert.match(source, /tee_status/);
  assert.match(source, /COVERAGE_RUST_LINES_FLOOR="90\.00"/);
  assert.match(source, /COVERAGE_RUNTIME_LINES_FLOOR="80\.00"/);
  assert.match(source, /COVERAGE_NATIVE_LINES_FLOOR="78\.00"/);
  assert.match(source, /check_coverage_floor/);
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
  assert.match(
    source,
    /run_gate coverage-rust rustup run "\$\{RUST_TOOLCHAIN\}" cargo llvm-cov/,
  );
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

test("Rust toolchain activation fails closed instead of mixing a missing Clippy tool", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ferrite-rust-toolchain-test-"));
  const shimBin = join(tempRoot, "shim-bin");
  const toolchainBin = join(tempRoot, "toolchain-bin");
  await mkdir(shimBin);
  await mkdir(toolchainBin);
  await writeFile(
    join(shimBin, "rustup"),
    '#!/bin/sh\nprintf "%s/%s\\n" "$FERRITE_TEST_TOOLCHAIN_BIN" "$4"\n',
    { mode: 0o755 },
  );
  await writeFile(join(shimBin, "clippy-driver"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  for (const tool of ["cargo", "rustc", "cargo-clippy", "rustfmt", "rustdoc"]) {
    await writeFile(join(toolchainBin, tool), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }

  try {
    const result = spawnSync(
      "/bin/bash",
      ["-c", `source '${ciUrl.pathname}'; activate_rust_toolchain`],
      {
        encoding: "utf8",
        env: {
          HOME: tempRoot,
          PATH: `${shimBin}:/usr/bin:/bin`,
          FERRITE_TEST_TOOLCHAIN_BIN: toolchainBin,
        },
      },
    );
    assert.notEqual(
      result.status,
      0,
      `toolchain activation unexpectedly passed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /clippy-driver did not resolve through Rust 1\.95\.0/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
  assert.doesNotMatch(source, /SSH_AUTH_SOCK|CARGO_HOME|PNPM_HOME/);
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
  assert.match(source, /ferrite-buildkite-home-/);
  assert.match(source, /original_rustup_home="\$\{RUSTUP_HOME:-\$\{original_home\}\/\.rustup\}"/);
  assert.match(source, /export RUSTUP_TOOLCHAIN="1\.95\.0"/);
  assert.match(source, /cargo-audit/);
  assert.match(source, /cargo-llvm-cov/);
  assert.match(source, /\/bin\/realpath/);
  assert.match(source, /export CARGO_HOME="\$\{build_home\}\/cargo"/);
  assert.match(source, /export PNPM_HOME="\$\{build_home\}\/pnpm"/);
  assert.match(source, /npm\/user\.npmrc/);
  assert.match(source, /npm\/global\.npmrc/);
  assert.match(source, /export DOCKER_CONFIG="\$\{build_home\}\/docker"/);
  assert.match(source, /export AWS_SHARED_CREDENTIALS_FILE="\$\{build_home\}\/aws\/credentials"/);
  assert.match(source, /export GOOGLE_APPLICATION_CREDENTIALS="\$\{build_home\}\/gcloud\/application_default_credentials\.json"/);
  assert.doesNotMatch(source, /\$\{HOME\}\/bin|\$\{HOME\}\/Library\/pnpm/);
  const tempRoot = await mkdtemp(join(tmpdir(), "ferrite-buildkite-hook-test-"));
  try {
    const operatorCargoHome = join(tempRoot, "operator-cargo");
    await mkdir(join(operatorCargoHome, "bin"), { recursive: true });
    await writeFile(
      join(operatorCargoHome, "bin", "rustup"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const isolated = runSourcedShell(
      environmentHookUrl,
      `printf '%s\\n' "$HOME" "$CARGO_HOME" "$RUSTUP_HOME" "$PNPM_HOME" "$NPM_CONFIG_USERCONFIG" "$NPM_CONFIG_GLOBALCONFIG" "$DOCKER_CONFIG" "$PATH"; cat "$DOCKER_CONFIG/config.json"; cat "$GOOGLE_APPLICATION_CREDENTIALS"; for tool in cargo rustc cargo-clippy clippy-driver rustfmt rustdoc; do printf '%s=%s:%s\\n' "$tool" "$(command -v "$tool")" "$(/usr/bin/readlink "$(command -v "$tool")")"; done`,
      {
        ...base,
        HOME: join(tempRoot, "user"),
        TMPDIR: tempRoot,
        PATH: "/tmp/user/bin:/tmp/user/pnpm:/usr/bin",
        CARGO_HOME: operatorCargoHome,
        RUSTUP_HOME: join(tempRoot, "operator-rustup"),
      },
    );
    assert.equal(isolated.status, 0, isolated.stderr);
    const [
      home,
      cargoHome,
      rustupHome,
      pnpmHome,
      npmUser,
      npmGlobal,
      dockerConfig,
      path,
      dockerJson,
      googleJson,
      ...proxyLinks
    ] = isolated.stdout.trim().split("\n");
    assert.match(home, new RegExp(`${tempRoot}/ferrite-buildkite-home-`));
    assert.equal(cargoHome, `${home}/cargo`);
    assert.equal(rustupHome, `${join(tempRoot, "operator-rustup")}`);
    assert.equal(pnpmHome, `${home}/pnpm`);
    assert.equal(npmUser, `${home}/npm/user.npmrc`);
    assert.equal(npmGlobal, `${home}/npm/global.npmrc`);
    assert.equal(dockerConfig, `${home}/docker`);
    assert.equal(dockerJson, "{}");
    assert.equal(googleJson, "{}");
    assert.doesNotMatch(path, /user\/bin|user\/pnpm|\/\.cargo\/bin/);
    assert.deepEqual(
      proxyLinks,
      [
        "cargo",
        "rustc",
        "cargo-clippy",
        "clippy-driver",
        "rustfmt",
        "rustdoc",
      ].map((tool) => `${tool}=${home}/toolchain/bin/${tool}:rustup`),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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

test("run_gate fails closed when the child or tee fails", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ferrite-run-gate-test-"));
  const workspace = join(tempRoot, "workspace");
  const reportRoot = join(tempRoot, "reports");
  const teePath = join(tempRoot, "tee-fails");
  await mkdir(workspace);
  await writeFile(join(workspace, "Cargo.lock"), "# test lockfile\n");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.email", "ferrite-test@example.invalid"],
    ["config", "user.name", "Ferrite Test"],
    ["add", "Cargo.lock"],
    ["commit", "--quiet", "-m", "test fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(teePath, "#!/bin/sh\nexit 19\n", { mode: 0o755 });
  const invoke = (body, env = {}) =>
    spawnSync(
      "/bin/bash",
      ["-c", `cd '${workspace}'; source '${ciUrl.pathname}'; mkdir -p "$REPORT_DIR"; : > "$REPORT_DIR/results.tsv"; ${body}`],
      { encoding: "utf8", env: { HOME: process.env.HOME, PATH: process.env.PATH, FERRITE_CI_REPORT_DIR: reportRoot, ...env } },
    );
  try {
    const success = invoke("run_gate preserves-log /bin/echo captured-output");
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /captured-output/);
    assert.equal(await readFile(join(reportRoot, "preserves-log.log"), "utf8"), "captured-output\n");
    const child = invoke("run_gate child-fails /bin/sh -c 'exit 7'");
    assert.equal(child.status, 7, child.stderr);
    assert.match(await readFile(join(reportRoot, "results.tsv"), "utf8"), /child-fails\t7/);
    assert.match(await readFile(join(reportRoot, "child-fails.source"), "utf8"), /end_commit=/);
    const tee = invoke("run_gate tee-fails /bin/echo ok", { TEE_BIN: teePath });
    assert.equal(tee.status, 19, tee.stderr);
    assert.match(await readFile(join(reportRoot, "results.tsv"), "utf8"), /tee-fails\t19/);
    assert.match(await readFile(join(reportRoot, "tee-fails.source"), "utf8"), /integrity_status=/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("run_gate captures command output before replaying it", async () => {
  const source = await readFile(ciUrl, "utf8");
  assert.match(source, /"\$@" >"\$\{log\}" 2>&1/);
  assert.match(source, /"\$\{TEE_BIN\}" -a \/dev\/null < "\$\{log\}"/);
  assert.doesNotMatch(source, /"\$@" 2>&1 \| "\$\{TEE_BIN\}"/);
});

test("coverage floors accept valid reports and reject empty, malformed, and under-floor reports", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ferrite-coverage-test-"));
  const invoke = (body) =>
    spawnSync(
      "/bin/bash",
      ["-c", `source '${ciUrl.pathname}'; mkdir -p "$REPORT_DIR"; ${body}`],
      { encoding: "utf8", env: { HOME: process.env.HOME, PATH: process.env.PATH, FERRITE_CI_REPORT_DIR: tempRoot } },
    );
  try {
    await writeFile(join(tempRoot, "rust-ok.log"), "TOTAL 90 8 90.99%\n");
    await writeFile(
      join(tempRoot, "js-ok.log"),
      "\u2139 all files | 81.57 | 70.00 | 88.00 |\n",
    );
    await writeFile(
      join(tempRoot, "js-legacy.log"),
      "# all files | 81.57 | 70.00 | 88.00 |\n",
    );
    assert.equal(invoke(`check_coverage_floor rust '${tempRoot}/rust-ok.log' 90.00`).status, 0);
    assert.equal(invoke(`check_coverage_floor js '${tempRoot}/js-ok.log' 80.00`).status, 0);
    assert.equal(invoke(`check_coverage_floor js '${tempRoot}/js-legacy.log' 80.00`).status, 0);

    await writeFile(join(tempRoot, "rust-low.log"), "TOTAL 90 15 89.99%\n");
    await writeFile(join(tempRoot, "js-malformed.log"), "# all files | n/a | 70.00 |\n");
    await writeFile(join(tempRoot, "js-misleading.log"), "not all files | 99.99 | 99.99 |\n");
    assert.notEqual(invoke(`check_coverage_floor rust '${tempRoot}/rust-low.log' 90.00`).status, 0);
    assert.notEqual(invoke(`check_coverage_floor js '${tempRoot}/js-malformed.log' 80.00`).status, 0);
    assert.notEqual(invoke(`check_coverage_floor js '${tempRoot}/js-misleading.log' 80.00`).status, 0);
    assert.notEqual(invoke(`check_coverage_floor js '${tempRoot}/missing.log' 80.00`).status, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("pre-exit cleanup removes only the validated per-build home", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "ferrite-pre-exit-test-"));
  const buildHome = join(tempRoot, "ferrite-buildkite-home-job-1");
  const invoke = (env) =>
    spawnSync(preExitHookUrl.pathname, [], {
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env },
    });
  try {
    await writeFile(join(tempRoot, "placeholder"), "ok");
    await writeFile(join(tempRoot, "marker"), "ok");
    const makeHome = spawnSync("/bin/mkdir", ["-p", buildHome], { encoding: "utf8" });
    assert.equal(makeHome.status, 0, makeHome.stderr);
    assert.equal(invoke({ TMPDIR: tempRoot, FERRITE_BUILDKITE_BUILD_HOME: buildHome }).status, 0);
    assert.equal((await stat(buildHome).catch(() => null)), null);
    assert.equal(invoke({ TMPDIR: tempRoot, FERRITE_BUILDKITE_BUILD_HOME: buildHome }).status, 0);
    assert.notEqual(invoke({ TMPDIR: tempRoot, FERRITE_BUILDKITE_BUILD_HOME: join(tempRoot, "other") }).status, 0);
    assert.notEqual(invoke({ TMPDIR: tempRoot, FERRITE_BUILDKITE_BUILD_HOME: `${tempRoot}/ferrite-buildkite-home-job-1/../etc` }).status, 0);
    assert.notEqual(invoke({ TMPDIR: "/", FERRITE_BUILDKITE_BUILD_HOME: "/ferrite-buildkite-home-job-1" }).status, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
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
  for (const url of [ciUrl, uploadUrl, environmentHookUrl, preCommandHookUrl, preExitHookUrl]) {
    await access(url);
    const metadata = await stat(url);
    assert.notEqual(metadata.mode & 0o111, 0);
  }
});
