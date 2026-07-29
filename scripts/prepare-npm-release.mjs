import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

export const REQUIRED_BUILDKITE_JOBS = Object.freeze([
  Object.freeze({
    stepKey: "ferrite-pipeline-upload",
    command: "./.buildkite/scripts/upload-pipeline.mjs",
  }),
  Object.freeze({
    stepKey: "ferrite-verify",
    command: "./.buildkite/scripts/ci.mjs verify",
  }),
  Object.freeze({
    stepKey: "ferrite-packages",
    command: "./.buildkite/scripts/ci.mjs packages",
  }),
  Object.freeze({
    stepKey: "ferrite-coverage-rust",
    command: "./.buildkite/scripts/ci.mjs coverage-rust",
  }),
  Object.freeze({
    stepKey: "ferrite-coverage-js",
    command: "./.buildkite/scripts/ci.mjs coverage-js",
  }),
  Object.freeze({
    stepKey: "ferrite-native",
    command: "./.buildkite/scripts/ci.mjs native",
  }),
  Object.freeze({
    stepKey: "ferrite-nginx",
    command: "./.buildkite/scripts/ci.mjs nginx",
  }),
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
  downloadArtifact = downloadBuildkiteArtifact,
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
  const currentJobs = (build.jobs ?? []).filter((job) => job?.retried !== true);
  const requiredKeys = new Set(REQUIRED_BUILDKITE_JOBS.map(({ stepKey }) => stepKey));
  const currentScriptJobs = currentJobs.filter((job) => job?.type === "script");
  if (
    currentScriptJobs.length !== REQUIRED_BUILDKITE_JOBS.length ||
    currentScriptJobs.some((job) => !requiredKeys.has(job.step_key))
  ) {
    throw new Error("npm release report Buildkite job topology does not match Ferrite CI.");
  }

  for (const expected of REQUIRED_BUILDKITE_JOBS) {
    const matches = currentScriptJobs.filter(({ step_key }) => step_key === expected.stepKey);
    if (matches.length !== 1) {
      throw new Error(
        `npm release report requires one current Buildkite ${expected.stepKey} job.`,
      );
    }
    const [job] = matches;
    if (
      job.command !== expected.command ||
      job.state !== "passed" ||
      job.exit_status !== 0 ||
      job.soft_failed !== false
    ) {
      throw new Error(
        `npm release report Buildkite ${expected.stepKey} job did not pass its exact contract.`,
      );
    }
  }

  const packageJob = currentScriptJobs.find(
    ({ step_key }) => step_key === "ferrite-packages",
  );
  if (packageJob?.id !== buildIdentity.jobId) {
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
  const artifactApiBase =
    `${pipelineApiUrl}/builds/${buildIdentity.buildNumber}` +
    `/jobs/${buildIdentity.jobId}/artifacts`;
  for (const item of expected) {
    const matches = artifacts.filter((artifact) =>
      artifact.path === item.path && artifact.job_id === buildIdentity.jobId
    );
    if (matches.length !== 1 || matches[0].state !== "finished") {
      throw new Error(`Buildkite package proof requires one finished artifact at ${item.path}.`);
    }
    const artifact = matches[0];
    if (
      typeof artifact.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(artifact.id) ||
      artifact.url !== `${artifactApiBase}/${artifact.id}` ||
      artifact.download_url !== `${artifactApiBase}/${artifact.id}/download`
    ) {
      throw new Error(`Buildkite artifact endpoint identity does not match ${item.path}.`);
    }
    const bytes = await readFile(item.localPath);
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (
      artifact.file_size !== bytes.byteLength ||
      artifact.sha1sum !== sha1
    ) {
      throw new Error(`Buildkite artifact identity does not match ${item.path}.`);
    }
    const downloaded = Buffer.from(await downloadArtifact({ artifact, buildIdentity }));
    const downloadedSha256 = createHash("sha256").update(downloaded).digest("hex");
    const localSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      downloaded.byteLength !== bytes.byteLength ||
      downloadedSha256 !== localSha256 ||
      !downloaded.equals(bytes)
    ) {
      throw new Error(`Buildkite downloaded artifact bytes do not match ${item.path}.`);
    }
  }
}

export async function downloadBuildkiteArtifact(
  { artifact, buildIdentity },
  {
    createStagingRoot = () => mkdtemp(join(tmpdir(), "ferrite-buildkite-artifact-")),
    removeStagingRoot = (path) => rm(path, { recursive: true, force: true }),
    runDownload = runBkDownload,
  } = {},
) {
  const stagingRoot = await createStagingRoot();
  let downloadedBytes;
  let downloadError;
  try {
    await runDownload(
      [
        "artifacts",
        "download",
        artifact.id,
        "--build",
        buildIdentity.buildNumber,
        "--pipeline",
        `${buildIdentity.organization}/${buildIdentity.pipeline}`,
        "--job-uuid",
        buildIdentity.jobId,
        "--yes",
        "--no-input",
      ],
      stagingRoot,
    );
    const [resolvedRoot, artifactInfo, resolvedArtifact] = await Promise.all([
      realpath(stagingRoot),
      lstat(resolve(stagingRoot, artifact.path)),
      realpath(resolve(stagingRoot, artifact.path)),
    ]);
    const downloadedRelative = relative(resolvedRoot, resolvedArtifact);
    if (
      !artifactInfo.isFile() ||
      artifactInfo.isSymbolicLink() ||
      downloadedRelative === "" ||
      downloadedRelative === ".." ||
      downloadedRelative.startsWith(`..${separator()}`) ||
      isAbsolute(downloadedRelative)
    ) {
      throw new Error(`Buildkite downloaded artifact path is unsafe: ${artifact.path}.`);
    }
    downloadedBytes = await readFile(resolvedArtifact);
  } catch (error) {
    downloadError = error;
  }
  try {
    await removeStagingRoot(stagingRoot);
  } catch (cleanupError) {
    if (downloadError) {
      throw new AggregateError(
        [downloadError, cleanupError],
        "Buildkite artifact download failed and private staging cleanup was incomplete.",
      );
    }
    throw cleanupError;
  }
  if (downloadError) throw downloadError;
  return downloadedBytes;
}

function runBkDownload(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bk", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Buildkite artifact download failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      resolvePromise();
    });
  });
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
