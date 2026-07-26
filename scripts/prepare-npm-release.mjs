import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectNpmTarball,
  packageSetIdentity,
  readGitIdentity,
  validateTarballAgainstReport,
} from "./verify-npm-packages.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PORTABLE_RELEASE_PACKAGES = Object.freeze([
  "@ferrite/protocol",
  "@ferrite/protocol-wasm",
  "@ferrite/runtime",
]);

export async function prepareNpmRelease({
  reportPath,
  version = "0.1.0-alpha.0",
  tag = "next",
  sourceIdentity,
  requireBuildkite = true,
  verifyBuildkite = verifyBuildkiteReport,
} = {}) {
  if (!reportPath) {
    throw new Error("npm release planning requires --report.");
  }
  if (!/^0\.1\.0-alpha\.\d+$/.test(version)) {
    throw new Error(`npm release version must be a 0.1.0 alpha prerelease, found ${version}.`);
  }
  if (tag !== "next") {
    throw new Error(`npm release dist-tag must be next, found ${tag}.`);
  }

  const resolvedReport = resolve(reportPath);
  const reportRoot = dirname(resolvedReport);
  const report = JSON.parse(await readFile(resolvedReport, "utf8"));
  if (
    !report ||
    report.schemaVersion !== 1 ||
    !Array.isArray(report.packages) ||
    typeof report.packageSetSha256 !== "string"
  ) {
    throw new Error("npm package report must be a version 1 release envelope.");
  }
  const currentSource = sourceIdentity ?? (await readGitIdentity(workspaceRoot));
  if (
    report.source?.commit !== currentSource.commit ||
    report.source?.tree !== currentSource.tree
  ) {
    throw new Error("npm package report source commit/tree does not match the current checkout.");
  }
  if (requireBuildkite && report.build?.provider !== "buildkite") {
    throw new Error("npm release planning requires an exact Buildkite package report.");
  }
  if (requireBuildkite) {
    await verifyBuildkite({ report, reportPath: resolvedReport });
  }
  const packageSetSha256 = createHash("sha256")
    .update(JSON.stringify(packageSetIdentity(report.packages)))
    .digest("hex");
  if (report.packageSetSha256 !== packageSetSha256) {
    throw new Error("npm package report package-set digest does not match.");
  }
  const byName = new Map();
  for (const entry of report.packages) {
    if (!entry || typeof entry.name !== "string" || byName.has(entry.name)) {
      throw new Error(`npm package report contains an invalid or duplicate package name.`);
    }
    byName.set(entry.name, entry);
  }

  const packages = [];
  for (const name of PORTABLE_RELEASE_PACKAGES) {
    const entry = byName.get(name);
    if (!entry) {
      throw new Error(`${name}: package is missing from the verified report.`);
    }
    validateManifest(name, entry, version);
    const artifact = await validateArtifact(name, entry.publishArtifact, reportRoot);
    validateTarballAgainstReport(name, entry, await inspectNpmTarball(artifact.path));
    packages.push({
      name,
      version,
      tag,
      artifact,
    });
  }
  validatePortableDependencies(byName, version);

  return {
    version,
    tag,
    source: report.source,
    build: report.build,
    packageSetSha256,
    packages,
    excluded: [
      {
        name: "@ferrite/node",
        reason: "requires the complete five-target native package set before publication",
      },
    ],
  };
}

export async function verifyBuildkiteReport({
  report,
  reportPath,
  runCommand = runBkJson,
} = {}) {
  const buildIdentity = report?.build;
  if (
    buildIdentity?.provider !== "buildkite" ||
    buildIdentity.organization !== "roman-mondello" ||
    buildIdentity.pipeline !== "ferrite" ||
    !/^\d+$/.test(buildIdentity.buildNumber ?? "")
  ) {
    throw new Error("npm release report does not identify the approved Ferrite Buildkite pipeline.");
  }
  const buildEndpoint =
    `/pipelines/${buildIdentity.pipeline}/builds/${buildIdentity.buildNumber}`;
  const pipelineApiUrl =
    "https://api.buildkite.com/v2/organizations/roman-mondello/pipelines/ferrite";
  const pipelineWebUrl = "https://buildkite.com/roman-mondello/ferrite";
  const buildWebUrl = `${pipelineWebUrl}/builds/${buildIdentity.buildNumber}`;
  const build = await runCommand([
    "api",
    buildEndpoint,
  ]);
  if (
    build?.pipeline?.slug !== "ferrite" ||
    build?.pipeline?.url !== pipelineApiUrl ||
    build?.pipeline?.web_url !== pipelineWebUrl ||
    build?.pipeline?.repository !== "git@github.com:integrate-your-mind/ferrite.git" ||
    build?.id !== buildIdentity.buildId ||
    String(build?.number) !== buildIdentity.buildNumber ||
    buildIdentity.url !== buildWebUrl ||
    build?.web_url !== buildIdentity.url ||
    build?.commit !== report.source?.commit ||
    build?.state !== "passed"
  ) {
    throw new Error("npm release report Buildkite build identity is not a passed exact-source build.");
  }
  const job = build.jobs?.find(({ id }) => id === buildIdentity.jobId);
  if (
    !job ||
    job.step_key !== "ferrite-packages" ||
    job.command !== "./.buildkite/scripts/ci.sh packages" ||
    job.state !== "passed" ||
    job.exit_status !== 0
  ) {
    throw new Error("npm release report is not bound to the passed Ferrite packages job.");
  }

  const artifacts = await runCommand([
    "api",
    `${buildEndpoint}/jobs/${buildIdentity.jobId}/artifacts`,
  ]);
  const reportRoot = dirname(reportPath);
  const verifiedPackageArtifacts = await Promise.all(
    report.packages
      .filter(({ publishArtifact }) => publishArtifact)
      .map(async ({ name, publishArtifact }) => ({
        path: `dist/npm-packages/${publishArtifact.path}`,
        localPath: (await validateArtifact(name, publishArtifact, reportRoot)).path,
      })),
  );
  const expected = [
    {
      path: "dist/npm-packages/npm-package-report.json",
      localPath: reportPath,
    },
    ...verifiedPackageArtifacts,
  ];
  for (const item of expected) {
    const matches = artifacts.filter((artifact) =>
      artifact.path === item.path && artifact.job_id === buildIdentity.jobId
    );
    if (matches.length !== 1 || matches[0].state !== "finished") {
      throw new Error(`Buildkite package proof requires one finished artifact at ${item.path}.`);
    }
    const bytes = await readFile(item.localPath);
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (
      matches[0].file_size !== bytes.byteLength ||
      matches[0].sha1sum !== sha1
    ) {
      throw new Error(`Buildkite artifact identity does not match ${item.path}.`);
    }
  }
}

function runBkJson(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bk", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Buildkite evidence lookup failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Buildkite evidence lookup returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function validateManifest(name, entry, version) {
  if (entry.version !== version || entry.packedManifest?.version !== version) {
    throw new Error(`${name}: verified package version must be ${version}.`);
  }
  if (entry.packedManifest?.name !== name) {
    throw new Error(`${name}: packed manifest name does not match.`);
  }
  if (Object.hasOwn(entry.packedManifest, "private")) {
    throw new Error(`${name}: packed manifest must not contain private.`);
  }
  const manifestText = JSON.stringify(entry.packedManifest);
  if (manifestText.includes("workspace:")) {
    throw new Error(`${name}: packed manifest contains a workspace dependency.`);
  }
  if (entry.packedManifest?.publishConfig?.access !== "public") {
    throw new Error(`${name}: packed manifest publishConfig.access must be public.`);
  }
}

async function validateArtifact(name, artifact, reportRoot) {
  if (
    !artifact ||
    typeof artifact.path !== "string" ||
    typeof artifact.filename !== "string" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error(`${name}: publish artifact identity is incomplete.`);
  }
  if (
    isAbsolute(artifact.path) ||
    basename(artifact.path) !== artifact.filename ||
    artifact.path !== `tarballs/${artifact.filename}` ||
    /[\u0000-\u001f\u007f]/.test(artifact.filename)
  ) {
    throw new Error(`${name}: publish artifact path is unsafe.`);
  }

  const [resolvedRoot, resolvedArtifact] = await Promise.all([
    realpath(reportRoot),
    realpath(resolve(reportRoot, artifact.path)),
  ]);
  const relativePath = relative(resolvedRoot, resolvedArtifact);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${separator()}`) || isAbsolute(relativePath)) {
    throw new Error(`${name}: publish artifact resolves outside the report directory.`);
  }

  const bytes = await readFile(resolvedArtifact);
  if (bytes.byteLength !== artifact.size) {
    throw new Error(`${name}: publish artifact byte size does not match the report.`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) {
    throw new Error(`${name}: publish artifact digest does not match the report.`);
  }
  return {
    path: resolvedArtifact,
    filename: artifact.filename,
    size: artifact.size,
    sha256,
  };
}

function validatePortableDependencies(byName, version) {
  for (const name of ["@ferrite/protocol-wasm", "@ferrite/runtime"]) {
    const protocolVersion = byName.get(name)?.packedManifest?.dependencies?.["@ferrite/protocol"];
    if (protocolVersion !== version) {
      throw new Error(`${name}: @ferrite/protocol dependency must be pinned to ${version}.`);
    }
  }
}

function separator() {
  return process.platform === "win32" ? "\\" : "/";
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--report" || flag === "--version" || flag === "--tag") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${flag} requires a value.`);
      }
      const key = flag === "--report" ? "reportPath" : flag.slice(2);
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

async function main() {
  const plan = await prepareNpmRelease(parseArgs(argv.slice(2)));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
