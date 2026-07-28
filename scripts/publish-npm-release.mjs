import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
  createReceipt = createPublicationReceipt,
  cleanupStaging = removeStagingDirectory,
  npmPreflight = preflightNpmRelease,
  runNpmCommand,
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
  const firstRegistry = await npmPreflight({
    packages: firstPlan.packages,
    version,
    registry: NPM_REGISTRY,
    runCommand: runNpmCommand ?? run,
  });
  const resolvedReceipt = resolve(
    receiptPath ?? join(dirname(resolve(reportPath)), "npm-publication-receipt.json"),
  );
  const published = [];
  const baseReceipt = {
    schemaVersion: 1,
    attemptId: randomUUID(),
    source: firstPlan.source,
    build: firstPlan.build,
    packageSetSha256: firstPlan.packageSetSha256,
    version,
    tag,
    registry: firstRegistry.registry,
    registryEvidence: firstRegistry,
    planned: firstPlan.packages.map(({ name, artifact }) => ({
      name,
      sha256: artifact.sha256,
    })),
  };
  await createReceipt(resolvedReceipt, {
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
      if (
        !isDeepStrictEqual(currentPlan.source, firstPlan.source) ||
        !isDeepStrictEqual(currentPlan.build, firstPlan.build)
      ) {
        throw new Error("npm release source/build identity changed after publication started.");
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
        phase = "registry_preflight";
        const currentRegistry = await npmPreflight({
          packages: [current],
          version,
          registry: NPM_REGISTRY,
          runCommand: runNpmCommand ?? run,
        });
        if (
          currentRegistry.registry !== firstRegistry.registry ||
          currentRegistry.identity !== firstRegistry.identity ||
          currentRegistry.twoFactorAuth !== firstRegistry.twoFactorAuth ||
          !isDeepStrictEqual(currentRegistry.org, firstRegistry.org) ||
          currentRegistry.access[current.name] !== firstRegistry.access[current.name] ||
          currentRegistry.versions[current.name] !== null
        ) {
          throw new Error("npm registry identity/access/version evidence changed after publication started.");
        }
        phase = "registry_publish";
        await runCommand(
          "npm",
          ["publish", stagedArtifact, "--access", "public", "--tag", tag, "--registry", NPM_REGISTRY],
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
    await writeSyncedJson(temporary, receipt, "wx");
    await rename(temporary, receiptPath);
    await syncParentDirectory(receiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createPublicationReceipt(receiptPath, receipt) {
  try {
    await writeSyncedJson(receiptPath, receipt, "wx");
    await syncParentDirectory(receiptPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Publication receipt already exists at ${receiptPath}; reconcile or archive it before starting another attempt.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function writeSyncedJson(path, value, flag) {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDirectory(path) {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
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

export const NPM_REGISTRY = "https://registry.npmjs.org/";
const PUBLISHABLE_ORG_ROLES = new Set(["owner", "admin", "developer"]);

export async function preflightNpmRelease({
  packages,
  version,
  registry = NPM_REGISTRY,
  runCommand = run,
  cwd,
} = {}) {
  if (registry !== NPM_REGISTRY) {
    throw new Error(`npm publication registry must be exactly ${NPM_REGISTRY}.`);
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("npm publication preflight requires a non-empty package set.");
  }
  const runNpmJson = (args) => runCommand(
    "npm",
    [...args, "--registry", registry],
    { cwd, capture: true, shell: false },
  );
  const whoami = parseJsonOutput(
    await runNpmJson(["whoami", "--json"]),
    "npm whoami",
  );
  const identity = parseNpmIdentity(whoami);
  const profile = parseJsonOutput(
    await runNpmJson(["profile", "get", "--json"]),
    "npm profile get",
  );
  const twoFactorAuth = parseTwoFactorAuth(profile);
  if (twoFactorAuth !== "auth-and-writes") {
    throw new Error(`npm account two-factor auth must be auth-and-writes, found ${twoFactorAuth ?? "missing"}.`);
  }
  const org = parseJsonOutput(
    await runNpmJson(["org", "ls", "ferrite", identity, "--json"]),
    "npm org ls",
  );
  const orgRole = parseOrgRole(org, identity);
  if (!PUBLISHABLE_ORG_ROLES.has(orgRole)) {
    throw new Error(`npm identity ${identity} does not have a publishable ferrite org role.`);
  }
  const accessRaw = parseJsonOutput(
    await runNpmJson(["access", "list", "packages", identity, "--json"]),
    "npm access list packages",
  );
  const access = parsePackageAccess(accessRaw);
  const packageEvidence = [];
  for (const pkg of packages) {
    const name = pkg?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("npm publication package entries require names.");
    }
    const accessLevel = access[name];
    if (accessLevel !== undefined && accessLevel !== "read-write") {
      throw new Error(`${name}: npm access must be read-write, found ${accessLevel}.`);
    }
    const exactVersion = `${name}@${version}`;
    let exists = false;
    try {
      const viewed = parseJsonOutput(
        await runNpmJson(["view", exactVersion, "version", "--json"]),
        `npm view ${exactVersion}`,
      );
      if (typeof viewed !== "string" || viewed !== version) {
        throw new Error(`${exactVersion}: npm registry returned malformed version metadata.`);
      }
      exists = true;
    } catch (error) {
      if (!isAuthenticatedExactVersion404(error)) throw error;
    }
    if (exists) {
      throw new Error(`${exactVersion}: exact npm version already exists; refusing overwrite.`);
    } else if (accessLevel !== undefined && accessLevel !== "read-write") {
      throw new Error(`${name}: npm package access is not publishable.`);
    }
    packageEvidence.push({ name, version, exists, access: accessLevel ?? "create" });
  }
  packageEvidence.sort((left, right) => left.name.localeCompare(right.name));
  return {
    registry,
    identity,
    twoFactorAuth,
    org: { organization: "ferrite", identity, role: orgRole },
    access: Object.fromEntries(packageEvidence.map(({ name, access: level }) => [name, level])),
    versions: Object.fromEntries(packageEvidence.map(({ name, exists }) => [name, exists ? version : null])),
    packages: packageEvidence,
  };
}

function parseJsonOutput(output, label) {
  if (output && typeof output === "object" && ("stdout" in output || "output" in output)) {
    output = output.stdout ?? output.output;
  }
  if (output && typeof output === "object") return output;
  try {
    return JSON.parse(Buffer.isBuffer(output) ? output.toString("utf8") : String(output));
  } catch (error) {
    throw new Error(`${label} returned malformed JSON.`, { cause: error });
  }
}

function parseNpmIdentity(value) {
  const identity = typeof value === "string" ? value : value?.username ?? value?.name;
  if (typeof identity !== "string" || identity.trim() === "") {
    throw new Error("npm whoami did not return an authenticated identity.");
  }
  return identity.trim();
}

function parseTwoFactorAuth(profile) {
  const value = profile?.["two-factor auth"];
  return typeof value === "string" ? value : value?.mode;
}

function parseOrgRole(org, identity) {
  const candidate = typeof org === "string" ? org : org?.[identity] ?? org?.role;
  const role = typeof candidate === "string" ? candidate : candidate?.role;
  if (typeof role !== "string") throw new Error("npm org ls returned malformed role JSON.");
  return role.toLowerCase();
}

function parsePackageAccess(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm access list packages returned malformed JSON.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, level]) => {
      if (level && typeof level === "object") level = level.access ?? level.permission;
      if (typeof level !== "string") throw new Error(`npm access returned malformed access for ${name}.`);
      return [name, level];
    }),
  );
}

function isAuthenticatedExactVersion404(error) {
  const text = [error?.code, error?.status, error?.stderr, error?.stdout, error?.message]
    .filter((value) => value !== undefined)
    .join(" ");
  return /(?:^|\b)(?:E404|404)(?:\b|$)/i.test(text) && !/E401|401|unauthor/i.test(text);
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

function run(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(capture ? stdout : undefined);
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
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
