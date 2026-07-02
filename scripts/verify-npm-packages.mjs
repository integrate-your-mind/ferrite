import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv, cwd, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

import { SUPPORTED_NATIVE_PREBUILD_TARGETS } from "../packages/node/binding.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(workspaceRoot, "dist", "npm-packages");
const gunzip = promisify(gunzipCallback);

export const RELEASE_PACKAGE_NAMES = Object.freeze([
  "@ferrite/protocol",
  "@ferrite/protocol-wasm",
  "@ferrite/runtime",
  "@ferrite/node",
]);

const RELEASE_PACKAGES = Object.freeze([
  Object.freeze({
    name: "@ferrite/protocol",
    directory: "packages/protocol",
    build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
    requiredFiles: ["dist/index.js", "dist/index.d.ts"],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/protocol-wasm",
    directory: "packages/protocol-wasm",
    build: ["pnpm", ["--filter", "@ferrite/protocol-wasm", "build"]],
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/ferrite_protocol_wasm.wasm",
    ],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/runtime",
    directory: "packages/runtime",
    build: ["pnpm", ["--filter", "@ferrite/runtime", "build"]],
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/dom.js",
      "dist/dom.d.ts",
      "dist/jsx-runtime.js",
      "dist/jsx-runtime.d.ts",
      "dist/server.js",
      "dist/server.d.ts",
    ],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/node",
    directory: "packages/node",
    build: ["pnpm", ["--filter", "@ferrite/node", "build"]],
    requiredFiles: ["binding.js", "index.js", "index.d.ts"],
    forbiddenFiles: ["dist/ferrite-node.node", "scripts", "test"],
  }),
]);

export function createReleaseManifest(
  sourceManifest,
  { packageVersions, nativePackageNames, repositoryUrl } = {},
) {
  const manifest = structuredClone(sourceManifest);
  delete manifest.private;
  rewriteWorkspaceDependencies(manifest, packageVersions ?? new Map());

  if (manifest.name === "@ferrite/node") {
    manifest.optionalDependencies = {
      ...(manifest.optionalDependencies ?? {}),
      ...Object.fromEntries((nativePackageNames ?? []).map((name) => [name, manifest.version])),
    };
  }

  if (repositoryUrl) {
    manifest.repository = {
      type: "git",
      url: repositoryUrl.endsWith(".git") ? repositoryUrl : `${repositoryUrl}.git`,
      directory: packageDirectoryFor(manifest.name),
    };
    const webUrl = repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, "");
    manifest.homepage = `${webUrl}#readme`;
    manifest.bugs = {
      url: `${webUrl}/issues`,
    };
  }

  return manifest;
}

export function validateManifestMetadata({
  packageName,
  sourceManifest,
  releaseManifest,
  publishManifestMode = false,
}) {
  assertString(sourceManifest.description, `${packageName}: package description is required.`);
  assertString(sourceManifest.license, `${packageName}: package license is required.`);
  assertArray(sourceManifest.keywords, `${packageName}: package keywords are required.`);
  assertArray(sourceManifest.files, `${packageName}: package files are required.`);
  if (!sourceManifest.exports || typeof sourceManifest.exports !== "object") {
    throw new Error(`${packageName}: package exports are required.`);
  }
  if (sourceManifest.publishConfig?.access !== "public") {
    throw new Error(`${packageName}: publishConfig.access must be public.`);
  }
  if (Object.hasOwn(releaseManifest, "private")) {
    throw new Error(`${packageName}: release manifest must not contain private.`);
  }
  assertNoWorkspaceSpecifiers(packageName, releaseManifest);

  if (publishManifestMode) {
    if (!releaseManifest.repository || !releaseManifest.homepage || !releaseManifest.bugs?.url) {
      throw new Error(`${packageName}: publish-manifest mode requires repository metadata.`);
    }
  }
}

export function validatePackFiles({ packageName, files, requiredFiles, forbiddenFiles }) {
  const normalized = new Set(files.map((file) => file.replace(/^package\//, "")));
  for (const required of requiredFiles) {
    if (!normalized.has(required)) {
      throw new Error(`${packageName}: packed package must include ${required}.`);
    }
  }
  for (const forbidden of forbiddenFiles) {
    if (normalized.has(forbidden) || [...normalized].some((file) => file.startsWith(`${forbidden}/`))) {
      throw new Error(`${packageName}: packed package must not include ${forbidden}.`);
    }
  }
}

export function validatePackedManifest({ packageName, releaseManifest, packedManifest }) {
  if (packedManifest.name !== releaseManifest.name) {
    throw new Error(`${packageName}: tarball manifest name ${packedManifest.name ?? "<missing>"} does not match.`);
  }
  if (packedManifest.version !== releaseManifest.version) {
    throw new Error(`${packageName}: tarball manifest version ${packedManifest.version ?? "<missing>"} does not match.`);
  }
  if (Object.hasOwn(packedManifest, "private")) {
    throw new Error(`${packageName}: tarball manifest must not contain private.`);
  }
  assertNoWorkspaceSpecifiers(packageName, packedManifest);
  assertReleaseDependencyFields(packageName, releaseManifest, packedManifest);
}

export async function verifyNpmPackages({
  publishManifestMode = false,
  repositoryUrl,
  writeReports = true,
  releasePackages = RELEASE_PACKAGES,
  nativePackageNames = SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => target.packageName),
  packageManifests,
  workspaceRoot: packageWorkspaceRoot = workspaceRoot,
  reportDir: packageReportDir = reportDir,
  runCommand = run,
  packPackage,
} = {}) {
  const packageVerifier = packPackage ?? npmPackPackage;
  const packageVersions = new Map();
  const manifests = new Map();
  const results = [];
  const stageRoot = await mkdtemp(join(tmpdir(), "ferrite-npm-stage-"));

  try {
    for (const config of releasePackages) {
      const sourceManifest =
        packageManifests?.get(config.name) ??
        (await readJson(join(packageWorkspaceRoot, config.directory, "package.json")));
      manifests.set(config.name, sourceManifest);
      packageVersions.set(config.name, sourceManifest.version);
    }

    assertAlignedVersions(packageVersions);

    for (const config of releasePackages) {
      await runCommand(config.build[0], config.build[1], { cwd: packageWorkspaceRoot });
      const packageDir = join(packageWorkspaceRoot, config.directory);
      const sourceManifest = manifests.get(config.name);
      const releaseManifest = createReleaseManifest(sourceManifest, {
        packageVersions,
        nativePackageNames,
        repositoryUrl,
      });
      validateManifestMetadata({
        packageName: config.name,
        sourceManifest,
        releaseManifest,
        publishManifestMode,
      });
      const stagedPackageDir = await stageReleasePackage({
        sourceDir: packageDir,
        stageRoot,
        packageName: config.name,
        releaseManifest,
      });
      const packResult = normalizePackResult(config.name, await packageVerifier(stagedPackageDir));
      validatePackFiles({
        packageName: config.name,
        files: packResult.files,
        requiredFiles: config.requiredFiles,
        forbiddenFiles: config.forbiddenFiles,
      });
      if (packResult.packedManifest) {
        validatePackedManifest({
          packageName: config.name,
          releaseManifest,
          packedManifest: packResult.packedManifest,
        });
      }
      const result = {
        name: config.name,
        directory: config.directory,
        version: sourceManifest.version,
        files: packResult.files,
        releaseManifest,
      };
      if (packResult.packedManifest) {
        result.packedManifest = packResult.packedManifest;
      }
      results.push(result);
    }

    if (writeReports) {
      await rm(packageReportDir, { force: true, recursive: true });
      await mkdir(packageReportDir, { recursive: true });
      await writeFile(join(packageReportDir, "npm-package-report.json"), `${JSON.stringify(results, null, 2)}\n`);
    }

    return results;
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
}

function rewriteWorkspaceDependencies(manifest, packageVersions) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        const version = packageVersions.get(name);
        if (!version) {
          throw new Error(`${manifest.name}: cannot rewrite ${field}.${name}; package version is unknown.`);
        }
        dependencies[name] = version;
      }
    }
  }
}

function assertNoWorkspaceSpecifiers(packageName, manifest) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        throw new Error(`${packageName}: release manifest contains workspace specifier ${field}.${name}.`);
      }
    }
  }
}

function assertReleaseDependencyFields(packageName, releaseManifest, packedManifest) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const releaseDependencies = releaseManifest[field];
    if (!releaseDependencies || typeof releaseDependencies !== "object") {
      continue;
    }
    const packedDependencies = packedManifest[field];
    if (!packedDependencies || typeof packedDependencies !== "object") {
      throw new Error(`${packageName}: tarball manifest is missing ${field}.`);
    }
    for (const [name, range] of Object.entries(releaseDependencies)) {
      if (packedDependencies[name] !== range) {
        throw new Error(`${packageName}: tarball manifest ${field}.${name} does not match ${range}.`);
      }
    }
  }
}

function assertAlignedVersions(packageVersions) {
  const versions = new Set(packageVersions.values());
  if (versions.size !== 1) {
    throw new Error(`Ferrite package versions must match: ${JSON.stringify(Object.fromEntries(packageVersions))}`);
  }
}

function packageDirectoryFor(packageName) {
  const config = RELEASE_PACKAGES.find((candidate) => candidate.name === packageName);
  if (!config) {
    throw new Error(`${packageName}: unknown release package.`);
  }
  return config.directory;
}

async function stageReleasePackage({ sourceDir, stageRoot, packageName, releaseManifest }) {
  const stagedPackageDir = join(stageRoot, sanitizePackageName(packageName));
  await cp(sourceDir, stagedPackageDir, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
  });
  await writeFile(join(stagedPackageDir, "package.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  return stagedPackageDir;
}

function sanitizePackageName(packageName) {
  return packageName.replace(/^@/, "").replace(/[\\/]/g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

function normalizePackResult(packageName, packResult) {
  if (Array.isArray(packResult)) {
    return { files: packResult, packedManifest: undefined };
  }
  if (!packResult || typeof packResult !== "object" || !Array.isArray(packResult.files)) {
    throw new Error(`${packageName}: package verifier did not return a packed file list.`);
  }
  return {
    files: packResult.files,
    packedManifest: packResult.packedManifest,
  };
}

async function npmPackPackage(packageDir) {
  const tarballDir = join(dirname(packageDir), ".tarballs");
  await mkdir(tarballDir, { recursive: true });
  const output = await run("npm", ["pack", "--json", "--pack-destination", tarballDir], { cwd: packageDir, capture: true });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`${packageDir}: npm pack --json returned invalid JSON: ${error.message}`);
  }
  const [entry] = parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`${packageDir}: npm pack output did not include a file list.`);
  }
  if (typeof entry.filename !== "string" || entry.filename.trim() === "") {
    throw new Error(`${packageDir}: npm pack output did not include a tarball filename.`);
  }
  const packedManifest = await readTarballPackageManifest(join(tarballDir, entry.filename));
  return {
    files: entry.files.map((file) => file.path),
    packedManifest,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readTarballPackageManifest(tarballPath) {
  const archive = await gunzip(await readFile(tarballPath));
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`${tarballPath}: invalid tar entry size for ${path}.`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new Error(`${tarballPath}: truncated tar entry for ${path}.`);
    }
    if (path === "package/package.json") {
      return JSON.parse(archive.subarray(dataStart, dataEnd).toString("utf8"));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${tarballPath}: package/package.json was not found.`);
}

function readTarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function assertString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
}

function assertArray(value, message) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

function run(command, args, { cwd: runCwd = cwd(), capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: runCwd,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

function parseArgs(args) {
  const options = {
    publishManifestMode: false,
    repositoryUrl: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--publish-manifest") {
      options.publishManifestMode = true;
    } else if (arg === "--repository-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--repository-url requires a value.");
      }
      options.repositoryUrl = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.publishManifestMode && !options.repositoryUrl) {
    throw new Error("--publish-manifest requires --repository-url.");
  }
  return options;
}

async function main() {
  const options = parseArgs(argv.slice(2));
  const results = await verifyNpmPackages(options);
  for (const result of results) {
    console.log(`Verified npm package tarball for ${result.name} with ${result.files.length} packed files.`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
