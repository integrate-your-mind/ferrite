import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { argv, cwd, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

import {
  SUPPORTED_NATIVE_PREBUILD_TARGETS,
  nativePrebuildPackageName,
} from "../packages/node/binding.js";
import { createPrebuildPackage } from "../packages/node/scripts/create-prebuild-package.mjs";
import { verifyPrebuildPackageDirs } from "../packages/node/scripts/verify-prebuild-package.mjs";
import { createSourceStarter } from "./create-source-starter.mjs";

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
  assertString(sourceManifest.engines?.node, `${packageName}: engines.node is required.`);
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
  packNativePackage = npmPackPackage,
  prepareNativePackage = packCurrentNativePrebuild,
  installPackageSet = installPackedPackageSet,
} = {}) {
  const packageVerifier = packPackage ?? npmPackPackage;
  const packageVersions = new Map();
  const manifests = new Map();
  const results = [];
  const installablePackages = [];
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
      const tarball = await inspectTarballIdentity(config.name, packResult, stageRoot);
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
      if (tarball) {
        result.tarball = tarball;
      }
      results.push(result);
      installablePackages.push({
        ...result,
        tarballPath: packResult.tarballPath,
      });
    }

    if (manifests.has("@ferrite/node")) {
      const nativeResult = await prepareNativePackage({
        packageWorkspaceRoot,
        packPackage: packNativePackage,
        publishManifestMode,
        stageRoot,
      });
      const { tarball: nativeTarball, tarballPath: _tarballPath, ...nativeReport } = nativeResult;
      const tarball = nativeTarball ?? (await inspectTarballIdentity(nativeResult.name, nativeResult, stageRoot));
      if (tarball) {
        nativeReport.tarball = tarball;
      }
      results.push(nativeReport);
      installablePackages.push(nativeResult);
    }

    await installPackageSet(installablePackages, { runCommand });

    if (writeReports) {
      await rm(packageReportDir, { force: true, recursive: true });
      await mkdir(packageReportDir, { recursive: true });
      await persistVerifiedTarballs(results, installablePackages, packageReportDir);
      await writeFile(join(packageReportDir, "npm-package-report.json"), `${JSON.stringify(results, null, 2)}\n`);
    }

    return results;
  } finally {
    await rm(stageRoot, { force: true, recursive: true });
  }
}

async function persistVerifiedTarballs(results, installablePackages, packageReportDir) {
  const tarballDir = join(packageReportDir, "tarballs");
  const filenames = new Set();

  for (const pkg of installablePackages) {
    if (!pkg.tarball || typeof pkg.tarballPath !== "string") {
      continue;
    }
    if (filenames.has(pkg.tarball.filename)) {
      throw new Error(`${pkg.name}: duplicate verified tarball filename ${pkg.tarball.filename}.`);
    }
    filenames.add(pkg.tarball.filename);
    await mkdir(tarballDir, { recursive: true });
    const destination = join(tarballDir, pkg.tarball.filename);
    await copyFile(pkg.tarballPath, destination);
    const copiedIdentity = await inspectTarballIdentity(
      pkg.name,
      {
        tarballPath: destination,
        npmReportedSize: pkg.tarball.size,
      },
      tarballDir,
    );
    if (copiedIdentity.sha256 !== pkg.tarball.sha256) {
      throw new Error(`${pkg.name}: persisted tarball digest does not match the verified source tarball.`);
    }
    const result = results.find((candidate) => candidate.name === pkg.name);
    if (!result) {
      throw new Error(`${pkg.name}: verified tarball has no report entry.`);
    }
    result.publishArtifact = {
      path: `tarballs/${pkg.tarball.filename}`,
      ...copiedIdentity,
    };
  }
}

export async function packCurrentNativePrebuild({
  packageWorkspaceRoot = workspaceRoot,
  packPackage = npmPackPackage,
  publishManifestMode = false,
  stageRoot,
} = {}) {
  if (!stageRoot) {
    throw new Error("Current native prebuild packaging requires a staging directory.");
  }
  const packageName = nativePrebuildPackageName();
  if (!packageName) {
    throw new Error(`No Ferrite native prebuild package is supported on ${process.platform}/${process.arch}.`);
  }

  const directory = join(stageRoot, sanitizePackageName(packageName));
  await createPrebuildPackage({
    packageRoot: join(packageWorkspaceRoot, "packages", "node"),
    destinationRoot: directory,
  });
  await verifyPrebuildPackageDirs([directory], { expectedPackages: [packageName] });

  const releaseManifest = await readJson(join(directory, "package.json"));
  validateManifestMetadata({
    packageName,
    sourceManifest: releaseManifest,
    releaseManifest,
    publishManifestMode,
  });
  const packResult = normalizePackResult(packageName, await packPackage(directory));
  const tarball = await inspectTarballIdentity(packageName, packResult, stageRoot);
  validatePackFiles({
    packageName,
    files: packResult.files,
    requiredFiles: ["ferrite-node.node", "ferrite-node.sha256.json"],
    forbiddenFiles: [],
  });
  if (packResult.packedManifest) {
    validatePackedManifest({ packageName, releaseManifest, packedManifest: packResult.packedManifest });
  }

  return {
    name: packageName,
    directory: "packages/node/dist/prebuild",
    version: releaseManifest.version,
    files: packResult.files,
    releaseManifest,
    ...(packResult.packedManifest ? { packedManifest: packResult.packedManifest } : {}),
    ...(tarball ? { tarball } : {}),
    tarballPath: packResult.tarballPath,
    kind: "native-prebuild",
  };
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
    return { files: packResult, packedManifest: undefined, npmReportedSize: undefined };
  }
  if (!packResult || typeof packResult !== "object" || !Array.isArray(packResult.files)) {
    throw new Error(`${packageName}: package verifier did not return a packed file list.`);
  }
  return {
    files: packResult.files,
    packedManifest: packResult.packedManifest,
    tarballPath: packResult.tarballPath,
    npmReportedSize: packResult.npmReportedSize ?? packResult.size,
  };
}

async function inspectTarballIdentity(packageName, { tarballPath, npmReportedSize } = {}, allowedRoot) {
  if (typeof tarballPath !== "string" || tarballPath.trim() === "") {
    return undefined;
  }

  const filename = basename(tarballPath);
  assertSafeTarballFilename(packageName, filename);
  const [resolvedAllowedRoot, resolvedTarballPath] = await Promise.all([
    realpath(allowedRoot),
    realpath(tarballPath),
  ]);
  const relativeTarballPath = relative(resolvedAllowedRoot, resolvedTarballPath);
  if (
    relativeTarballPath === "" ||
    relativeTarballPath === ".." ||
    relativeTarballPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeTarballPath)
  ) {
    throw new Error(`${packageName}: packed tarball resolves outside the staging directory.`);
  }

  const bytes = await readFile(resolvedTarballPath);
  if (typeof npmReportedSize !== "undefined") {
    if (!Number.isSafeInteger(npmReportedSize) || npmReportedSize < 0) {
      throw new Error(`${packageName}: npm pack returned an invalid tarball size.`);
    }
    if (npmReportedSize !== bytes.byteLength) {
      throw new Error(
        `${packageName}: npm pack reported tarball size ${npmReportedSize}, actual bytes are ${bytes.byteLength}.`,
      );
    }
  }

  return {
    filename,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertSafeTarballFilename(packageName, filename) {
  if (
    typeof filename !== "string" ||
    filename.trim() === "" ||
    filename === "." ||
    filename === ".." ||
    filename !== filename.split(/[\\/]/).at(-1) ||
    /[\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw new Error(`${packageName}: npm pack returned an unsafe tarball filename.`);
  }
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
  assertSafeTarballFilename(packageDir, entry.filename);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`${packageDir}: npm pack output did not include a valid tarball size.`);
  }
  const tarballPath = join(tarballDir, entry.filename);
  const packedManifest = await readTarballPackageManifest(tarballPath);
  return {
    files: entry.files.map((file) => file.path),
    packedManifest,
    tarballPath,
    npmReportedSize: entry.size,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function installPackedPackageSet(packages, { runCommand = run } = {}) {
  assertInstallablePackages(packages);
  const installRoot = await mkdtemp(join(tmpdir(), "ferrite-npm-install-"));
  try {
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await runCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--fund=false",
        ...packages.map((pkg) => pkg.tarballPath),
      ],
      { cwd: installRoot, capture: true },
    );
    await runCommand("node", ["--input-type=module", "--eval", installSmokeScript(packages)], {
      cwd: installRoot,
      capture: true,
    });
    if (packages.some((pkg) => pkg.name === "@ferrite/runtime")) {
      await verifyCleanDeveloperWorkflow(installRoot, { packages, runCommand });
    }
  } finally {
    await rm(installRoot, { force: true, recursive: true });
  }
}

export async function verifyCleanDeveloperWorkflow(
  installRoot,
  { packages = [], runCommand = run, cliSource = join(workspaceRoot, "target", "debug", process.platform === "win32" ? "ferrite.exe" : "ferrite") } = {},
) {
  const project = join(installRoot, "starter");
  await createSourceStarter({ target: project, packages, cliSource, runCommand });
  const cliPath = join(project, ".ferrite-source", "bin", process.platform === "win32" ? "ferrite.exe" : "ferrite");
  const runtimeBin = join(project, "node_modules", "@ferrite", "runtime", "bin");

  await assertCommandFails(
    runCommand,
    cliPath,
    ["serve", "--project", project, "--artifact", ".ferrite/build", "--page-renderer", join(runtimeBin, "render-artifact.mjs"), "--once"],
    { cwd: project, capture: true },
    /artifact directory[\s\S]*\bos error (?:2|3)\b/i,
    "clean install serve must reject a missing build artifact",
  );
  await runCommand(
    cliPath,
    ["build", "--project", project, "--page-renderer", join(runtimeBin, "render-page.mjs"), "--client-bundler", join(runtimeBin, "build-client.mjs")],
    { cwd: project, capture: true },
  );
  const output = await runCommand(
    cliPath,
    ["serve", "--project", project, "--artifact", ".ferrite/build", "--page-renderer", join(runtimeBin, "render-artifact.mjs"), "--once"],
    { cwd: project, capture: true },
  );
  if (!output.includes("Rust-first application runtime.")) {
    throw new Error("clean install artifact serve did not render the fixture page");
  }
}

async function assertCommandFails(runCommand, command, args, options, expectedError, message) {
  try {
    await runCommand(command, args, options);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (expectedError.test(errorMessage)) {
      return;
    }
    throw new Error(`${message}: unexpected failure: ${errorMessage}`, { cause: error });
  }
  throw new Error(message);
}

function assertInstallablePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("npm install smoke requires at least one package tarball.");
  }
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== "object" || typeof pkg.name !== "string" || pkg.name.trim() === "") {
      throw new Error("npm install smoke package entries require a package name.");
    }
    if (typeof pkg.tarballPath !== "string" || pkg.tarballPath.trim() === "") {
      throw new Error(`${pkg.name}: npm install smoke requires a local tarball path.`);
    }
  }
}

function installSmokeScript(packages) {
  return `
import { readFile } from "node:fs/promises";

const packageNames = new Set(${JSON.stringify(packages.map((pkg) => pkg.name))});

if (packageNames.has("@ferrite/protocol")) {
  const protocol = await import("@ferrite/protocol");
  if (typeof protocol.validateServerPayloadPacket !== "function") {
    throw new TypeError("@ferrite/protocol did not expose validateServerPayloadPacket.");
  }
  const validPayload = {
    ferrite: "server-payload",
    version: 1,
    shell: [0, "packed protocol"],
    clientReferences: [],
    chunks: [],
  };
  if (protocol.validateServerPayloadPacket(validPayload) !== validPayload) {
    throw new TypeError("@ferrite/protocol did not validate the packaged protocol payload.");
  }
  let invalidPayloadRejected = false;
  try {
    protocol.validateServerPayloadPacket({ ...validPayload, version: 99 });
  } catch {
    invalidPayloadRejected = true;
  }
  if (!invalidPayloadRejected) {
    throw new TypeError("@ferrite/protocol accepted an unsupported payload version.");
  }
}

if (packageNames.has("@ferrite/protocol-wasm")) {
  const wasm = await import("@ferrite/protocol-wasm");
  if (typeof wasm.instantiateFerriteProtocolWasm !== "function") {
    throw new TypeError("@ferrite/protocol-wasm did not expose instantiateFerriteProtocolWasm.");
  }
  const wasmBytes = await readFile("node_modules/@ferrite/protocol-wasm/dist/ferrite_protocol_wasm.wasm");
  const protocolWasm = await wasm.instantiateFerriteProtocolWasm(wasmBytes);
  const validPayload = {
    ferrite: "server-payload",
    version: 1,
    shell: [0, "packed wasm"],
    clientReferences: [],
    chunks: [],
  };
  if (protocolWasm.validateServerPayload(validPayload) !== validPayload) {
    throw new TypeError("@ferrite/protocol-wasm did not validate the packaged WASM payload.");
  }
  let invalidPayloadRejected = false;
  try {
    protocolWasm.validateServerPayload({ ...validPayload, version: 99 });
  } catch {
    invalidPayloadRejected = true;
  }
  if (!invalidPayloadRejected) {
    throw new TypeError("@ferrite/protocol-wasm packaged WASM accepted an unsupported payload version.");
  }
}

if (packageNames.has("@ferrite/runtime")) {
  const runtime = await import("@ferrite/runtime");
  const dom = await import("@ferrite/runtime/dom");
  const jsxRuntime = await import("@ferrite/runtime/jsx-runtime");
  const server = await import("@ferrite/runtime/server");
  if (typeof runtime.createElement !== "function") {
    throw new TypeError("@ferrite/runtime did not expose createElement.");
  }
  if (typeof dom.mount !== "function" || typeof jsxRuntime.jsx !== "function" || typeof server.renderPageModule !== "function") {
    throw new TypeError("@ferrite/runtime package subpath exports are incomplete.");
  }
}

if (packageNames.has("@ferrite/node")) {
  const node = await import("@ferrite/node");
  const html = node.renderJsonToHtml(JSON.stringify({
    ferrite: "render-packet",
    version: 1,
    root: [2, "main", {}, [[0, "packed native"]]],
  }));
  if (html !== "<main>packed native</main>") {
    throw new TypeError("@ferrite/node did not load and render through the packaged native prebuild.");
  }
  let invalidPacketRejected = false;
  try {
    node.renderJsonToHtml(JSON.stringify({ ferrite: "render-packet", version: 99, root: [0, "bad"] }));
  } catch {
    invalidPacketRejected = true;
  }
  if (!invalidPacketRejected) {
    throw new TypeError("@ferrite/node accepted an unsupported render packet version.");
  }
}
`;
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
