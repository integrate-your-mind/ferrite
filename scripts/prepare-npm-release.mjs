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
