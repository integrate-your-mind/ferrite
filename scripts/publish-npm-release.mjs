import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  receiptPath,
  verifyBuildkite,
  writeReceipt = writePublicationReceipt,
  cleanupStaging = removeStagingDirectory,
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
    verifyBuildkite,
  });
  const resolvedReceipt = resolve(
    receiptPath ?? join(dirname(resolve(reportPath)), "npm-publication-receipt.json"),
  );
  const published = [];
  const baseReceipt = {
    schemaVersion: 1,
    source: firstPlan.source,
    build: firstPlan.build,
    packageSetSha256: firstPlan.packageSetSha256,
    version,
    tag,
    planned: firstPlan.packages.map(({ name, artifact }) => ({
      name,
      sha256: artifact.sha256,
    })),
  };
  await writeReceipt(resolvedReceipt, {
    ...baseReceipt,
    status: "started",
    published,
  });

  let currentName = firstPlan.packages[0]?.name;
  let phase = "revalidation";
  let registryConfirmed = false;
  try {
    for (const [index, expected] of firstPlan.packages.entries()) {
      currentName = expected.name;
      phase = "revalidation";
      registryConfirmed = false;
      const currentPlan = await prepareNpmRelease({
        reportPath,
        version,
        tag,
        sourceIdentity,
        requireBuildkite: true,
        verifyBuildkite,
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

      phase = "staging";
      const stagingRoot = await mkdtemp(join(tmpdir(), "ferrite-npm-publish-"));
      try {
        const stagedArtifact = await stageVerifiedArtifact(current, stagingRoot);
        phase = "receipt_before_publish";
        await writeReceipt(resolvedReceipt, {
          ...baseReceipt,
          status: "in_progress",
          published,
          attempting: {
            name: current.name,
            sha256: current.artifact.sha256,
          },
        });
        phase = "registry_publish";
        await runCommand(
          "npm",
          ["publish", stagedArtifact, "--access", "public", "--tag", tag],
          { cwd: stagingRoot },
        );
        registryConfirmed = true;
        published.push({
          name: current.name,
          version,
          tag,
          sha256: current.artifact.sha256,
        });
      } finally {
        phase = registryConfirmed
          ? "cleanup_after_confirmed_publish"
          : phase === "registry_publish"
            ? "cleanup_after_ambiguous_publish"
            : "cleanup_before_publish";
        await cleanupStaging(stagingRoot);
      }
      phase = "receipt_after_confirmed_publish";
      await writeReceipt(resolvedReceipt, {
        ...baseReceipt,
        status: index === firstPlan.packages.length - 1 ? "complete" : "in_progress",
        published,
      });
      phase = "idle";
    }
  } catch (error) {
    const ambiguous =
      !registryConfirmed &&
      (phase === "registry_publish" || phase === "cleanup_after_ambiguous_publish");
    const status = registryConfirmed
      ? published.length === firstPlan.packages.length
        ? "complete_with_error"
        : "partial"
      : ambiguous
        ? published.length > 0
          ? "partial"
          : "ambiguous"
        : published.length > 0
          ? "partial"
          : "failed";
    const failure = registryConfirmed
      ? {
          postPublicationFailure: {
            name: currentName,
            phase,
            reason: "registry success was confirmed but local completion did not finish",
          },
        }
      : ambiguous
        ? {
            ambiguous: {
              name: currentName,
              phase: "registry_publish",
              reason: "registry outcome must be read back before retry",
            },
          }
        : {
            failed: {
              name: currentName,
              phase,
              reason: "failure occurred before registry success was confirmed",
            },
          };
    const failureReceipt = {
      ...baseReceipt,
      status,
      published,
      ...failure,
    };
    try {
      await writeReceipt(resolvedReceipt, failureReceipt);
    } catch (receiptError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `Publication receipt update also failed at ${resolvedReceipt}; ` +
          "the last durable pre-mutation receipt must be treated as ambiguous.",
        { cause: new AggregateError([error, receiptError]) },
      );
    }
    const summary = published.length > 0
      ? published.map(({ name }) => name).join(", ")
      : "none";
    const outcome = ambiguous
      ? `${currentName} has an ambiguous registry outcome`
      : registryConfirmed
        ? `${currentName} was confirmed published before a local ${phase} failure`
        : `${currentName} failed before publication was confirmed`;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Publication receipt: ${resolvedReceipt}; confirmed published: ${summary}; ${outcome}.`,
      { cause: error },
    );
  }
  return {
    source: firstPlan.source,
    build: firstPlan.build,
    published,
    receiptPath: resolvedReceipt,
  };
}

export async function writePublicationReceipt(receiptPath, receipt) {
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, receiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeStagingDirectory(stagingRoot) {
  await chmod(stagingRoot, 0o700).catch(() => {});
  await rm(stagingRoot, { recursive: true, force: true });
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
    } else if (
      flag === "--report" ||
      flag === "--version" ||
      flag === "--tag" ||
      flag === "--receipt"
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${flag} requires a value.`);
      }
      options[
        flag === "--report"
          ? "reportPath"
          : flag === "--receipt"
            ? "receiptPath"
            : flag.slice(2)
      ] = value;
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
