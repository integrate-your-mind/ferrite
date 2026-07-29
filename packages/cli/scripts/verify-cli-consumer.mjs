import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv, env, platform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createCliCandidate,
  verifyCliCandidate,
} from "./create-cli-candidate.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");

export async function verifyCliConsumer({
  binaryPath = defaultBinaryPath(),
  candidateRoot = join(workspaceRoot, "dist", "cli-candidate"),
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
} = {}) {
  const candidate = await createCliCandidate({ binaryPath, destinationRoot: candidateRoot });
  const verified = await verifyCliCandidate(candidate.root);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ferrite cli consumer "));
  const tarballRoot = join(temporaryRoot, "tarballs");
  const consumerRoot = join(temporaryRoot, "consumer");

  try {
    await mkdir(tarballRoot, { recursive: true });
    const platformTarball = pack(
      npmCommand,
      candidate.platformDirectory,
      tarballRoot,
      temporaryRoot,
    );
    const wrapperTarball = pack(
      npmCommand,
      candidate.wrapperDirectory,
      tarballRoot,
      temporaryRoot,
    );
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "ferrite-cli-consumer", private: true }, null, 2)}\n`,
    );

    const offlineEnvironment = {
      ...env,
      npm_config_cache: join(temporaryRoot, "npm-cache"),
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:9",
    };
    run(
      npmCommand,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        platformTarball,
        wrapperTarball,
      ],
      { cwd: consumerRoot, env: offlineEnvironment },
    );

    const ferrite = join(
      consumerRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "ferrite.cmd" : "ferrite",
    );
    const version = run(ferrite, ["--version"], { cwd: consumerRoot }).stdout.trim();
    if (!/^ferrite [0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
      throw new Error(`Packaged Ferrite CLI returned an unexpected version: ${version}`);
    }

    const project = join(consumerRoot, "app with spaces");
    run(ferrite, ["init", project], { cwd: consumerRoot });
    const projectManifest = JSON.parse(
      await readFile(join(project, "package.json"), "utf8"),
    );
    if (
      projectManifest.dependencies?.["@ferrite/runtime"] !== candidate.packageVersion ||
      projectManifest.devDependencies?.["@ferrite/cli"] !== candidate.packageVersion
    ) {
      throw new Error(
        "Packaged Ferrite CLI did not pin matching runtime and CLI npm versions.",
      );
    }

    const marker = join(project, "owned.txt");
    await writeFile(marker, "keep\n");
    const refusal = run(ferrite, ["init", project], {
      cwd: consumerRoot,
      expectFailure: true,
    });
    if (!/refusing to initialize non-empty directory/.test(refusal.stderr)) {
      throw new Error("Packaged Ferrite CLI did not report its existing-target refusal.");
    }
    if ((await readFile(marker, "utf8")) !== "keep\n") {
      throw new Error("Packaged Ferrite CLI modified the existing-target marker.");
    }

    const installedBinary = join(
      consumerRoot,
      "node_modules",
      "@ferrite",
      candidate.platformPackage.split("/")[1],
      "bin",
      platform === "win32" ? "ferrite.exe" : "ferrite",
    );
    await writeFile(installedBinary, "tampered");
    await chmod(installedBinary, 0o755);
    const tamper = run(ferrite, ["--version"], {
      cwd: consumerRoot,
      expectFailure: true,
    });
    if (!/(checksum mismatch|binary size mismatch)/.test(tamper.stderr)) {
      throw new Error("Packaged Ferrite CLI did not reject a tampered binary.");
    }

    return {
      candidateRoot: candidate.root,
      packageVersion: candidate.packageVersion,
      platformPackage: candidate.platformPackage,
      sha256: verified.sha256,
      bytes: verified.bytes,
      binaryVersion: version,
      offlineInstall: "passed",
      existingTargetRefusal: "passed",
      tamperRejection: "passed",
      applicationDependencies: "not installed; registry or complete local tarballs required",
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function pack(npmCommand, packageDirectory, tarballRoot, cwd) {
  const result = run(
    npmCommand,
    ["pack", packageDirectory, "--json", "--pack-destination", tarballRoot],
    { cwd },
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
  const filename = Array.isArray(report) ? report[0]?.filename : undefined;
  if (
    !Array.isArray(report) ||
    report.length !== 1 ||
    typeof filename !== "string" ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack did not return one safe tarball filename.");
  }
  return join(tarballRoot, filename);
}

function defaultBinaryPath() {
  const targetRoot = env.CARGO_TARGET_DIR
    ? resolve(env.CARGO_TARGET_DIR)
    : join(workspaceRoot, "target");
  return join(targetRoot, "debug", platform === "win32" ? "ferrite.exe" : "ferrite");
}

function run(command, args, {
  cwd,
  env: commandEnvironment = env,
  expectFailure = false,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (expectFailure) {
    if (result.status === 0) {
      throw new Error(`Expected ${command} ${args.join(" ")} to fail.`);
    }
  } else if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}.\n` +
        `${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

async function main() {
  const result = await verifyCliConsumer({
    binaryPath: argv[2] ? resolve(argv[2]) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  argv[1] &&
  import.meta.url === pathToFileURL(resolve(argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
