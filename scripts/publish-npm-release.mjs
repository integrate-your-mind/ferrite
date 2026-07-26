import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import { prepareNpmRelease } from "./prepare-npm-release.mjs";

export async function publishNpmRelease({
  reportPath,
  version = "0.1.0-alpha.0",
  tag = "next",
  execute = false,
  sourceIdentity,
  runCommand = run,
} = {}) {
  if (!execute) {
    throw new Error("npm publication requires the explicit --execute flag.");
  }

  const firstPlan = await prepareNpmRelease({
    reportPath,
    version,
    tag,
    sourceIdentity,
    requireBuildkite: true,
  });
  const published = [];
  for (const expected of firstPlan.packages) {
    const currentPlan = await prepareNpmRelease({
      reportPath,
      version,
      tag,
      sourceIdentity,
      requireBuildkite: true,
    });
    if (currentPlan.packageSetSha256 !== firstPlan.packageSetSha256) {
      throw new Error("npm package set changed after publication started.");
    }
    const current = currentPlan.packages.find(({ name }) => name === expected.name);
    if (!current) {
      throw new Error(`${expected.name}: package disappeared from the revalidated release plan.`);
    }
    if (
      current.artifact.filename !== expected.artifact.filename ||
      current.artifact.size !== expected.artifact.size ||
      current.artifact.sha256 !== expected.artifact.sha256
    ) {
      throw new Error(`${expected.name}: artifact identity changed after publication started.`);
    }

    const stagingRoot = await mkdtemp(join(tmpdir(), "ferrite-npm-publish-"));
    try {
      const stagedArtifact = await stageVerifiedArtifact(current, stagingRoot);
      await runCommand(
        "npm",
        ["publish", stagedArtifact, "--access", "public", "--tag", tag],
        { cwd: stagingRoot },
      );
      published.push({
        name: current.name,
        version,
        tag,
        sha256: current.artifact.sha256,
      });
    } finally {
      await chmod(stagingRoot, 0o700).catch(() => {});
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
  return { source: firstPlan.source, build: firstPlan.build, published };
}

export async function stageVerifiedArtifact(pkg, stagingRoot) {
  const bytes = await readFile(pkg.artifact.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== pkg.artifact.size || sha256 !== pkg.artifact.sha256) {
    throw new Error(`${pkg.name}: publish artifact changed after release planning.`);
  }
  const destination = join(stagingRoot, pkg.artifact.filename);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
  const stagedBytes = await readFile(destination);
  const stagedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
  if (stagedBytes.byteLength !== pkg.artifact.size || stagedSha256 !== pkg.artifact.sha256) {
    throw new Error(`${pkg.name}: immutable publish staging changed the artifact.`);
  }
  await chmod(stagingRoot, 0o500);
  return destination;
}

export function parsePublishArgs(args) {
  const options = { execute: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--execute") {
      options.execute = true;
    } else if (flag === "--report" || flag === "--version" || flag === "--tag") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${flag} requires a value.`);
      }
      options[flag === "--report" ? "reportPath" : flag.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

async function main() {
  const result = await publishNpmRelease(parsePublishArgs(argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
