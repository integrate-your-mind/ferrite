import { createHash } from "node:crypto";
import { constants as fsConstants, lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process, { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NATIVE_CHECKSUM_ALGORITHM,
  SUPPORTED_NATIVE_PREBUILD_TARGETS,
} from "../binding.js";

const checksumFile = "ferrite-node.sha256.json";
const bindingFile = "ferrite-node.node";
const supportedTargets = new Map(
  SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => [target.packageName, target]),
);

export async function verifyPrebuildPackageDirs(directories, { expectedPackages = [] } = {}) {
  if (!Array.isArray(directories) || directories.length === 0) {
    throw new Error("At least one Ferrite native prebuild package directory is required.");
  }

  const results = [];
  for (const directory of directories) {
    results.push(await verifyPrebuildPackageDir(directory));
  }
  verifyExpectedPackages(results, expectedPackages);
  return results;
}

export async function discoverPrebuildPackageDirs(root) {
  const rootInfo = await assertDirectory(root, "prebuild root");
  const entries = await readdir(rootInfo.canonical, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    const entryPath = join(rootInfo.canonical, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`${entryPath}: prebuild directory must not be a symlink or reparse point.`);
    }
    if (entry.isDirectory()) {
      directories.push(join(root, entry.name));
    }
  }
  return directories.sort();
}

async function verifyPrebuildPackageDir(directory) {
  const root = resolve(directory);
  const rootInfo = await assertDirectory(root, "native prebuild package");
  const manifest = await readJsonObject(
    join(root, "package.json"),
    "package manifest",
    rootInfo.canonical,
  );
  const checksum = await readJsonObject(
    join(root, checksumFile),
    "checksum manifest",
    rootInfo.canonical,
  );
  const bindingPath = join(root, bindingFile);
  const binding = await readNonEmptyFile(bindingPath, "native binding", rootInfo.canonical);
  const target = supportedTargets.get(manifest.name);
  if (!target) {
    throw new Error(`${root}: unsupported native prebuild package ${String(manifest.name)}.`);
  }

  await assertPackageManifest(root, manifest, target);
  assertChecksumManifest(root, checksum);
  const actual = createHash(NATIVE_CHECKSUM_ALGORITHM).update(binding).digest("hex");
  if (actual !== checksum.sha256) {
    throw new Error(
      `${root}: checksum mismatch for ${bindingFile}: expected ${checksum.sha256}, got ${actual}.`,
    );
  }

  return {
    packageName: manifest.name,
    directory: root,
  };
}

async function assertPackageManifest(root, manifest, target) {
  const nodePackage = await nodePackageManifest();
  assertArrayEquals(root, manifest.os, [target.os], `must declare os ${target.os}`);
  assertArrayEquals(root, manifest.cpu, [target.cpu], `must declare cpu ${target.cpu}`);
  if (manifest.version !== nodePackage.version) {
    throw new Error(`${root}: package version must match @ferrite/node.`);
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    throw new Error(`${root}: package description is required.`);
  }
  if (manifest.license !== nodePackage.license) {
    throw new Error(`${root}: package license must match @ferrite/node.`);
  }
  for (const field of ["repository", "homepage", "bugs", "engines"]) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(nodePackage[field])) {
      throw new Error(`${root}: package ${field} must match @ferrite/node.`);
    }
  }
  assertArrayIncludes(root, manifest.keywords, "ferrite", "keywords");
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${root}: package publishConfig.access must be public.`);
  }
  assertArrayIncludes(root, manifest.files, bindingFile, "files");
  assertArrayIncludes(root, manifest.files, checksumFile, "files");
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    throw new Error(`${root}: package exports must be a JSON object.`);
  }
  if (manifest.exports[`./${bindingFile}`] !== `./${bindingFile}`) {
    throw new Error(`${root}: package exports must expose ./${bindingFile}.`);
  }
  if (manifest.exports[`./${checksumFile}`] !== `./${checksumFile}`) {
    throw new Error(`${root}: package exports must expose ./${checksumFile}.`);
  }
}

function assertChecksumManifest(root, checksum) {
  if (checksum.file !== bindingFile) {
    throw new Error(`${root}: ${checksumFile} must describe ${bindingFile}.`);
  }
  if (checksum.algorithm !== NATIVE_CHECKSUM_ALGORITHM) {
    throw new Error(`${root}: ${checksumFile} must use ${NATIVE_CHECKSUM_ALGORITHM}.`);
  }
  if (typeof checksum.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksum.sha256)) {
    throw new Error(`${root}: ${checksumFile} must include a lowercase hex sha256 digest.`);
  }
}

function verifyExpectedPackages(results, expectedPackages) {
  const seen = new Map();
  for (const result of results) {
    seen.set(result.packageName, (seen.get(result.packageName) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, count]) => count !== 1).map(([name]) => name);
  if (duplicates.length > 0) {
    throw new Error(`duplicate prebuild packages: ${duplicates.join(", ")}`);
  }
  const missing = expectedPackages.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`missing expected prebuild packages: ${missing.join(", ")}`);
  }
}

let cachedNodePackageManifest;
async function nodePackageManifest() {
  if (!cachedNodePackageManifest) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const nodeRoot = resolve(packageRoot);
    const nodeRootInfo = await assertDirectory(nodeRoot, "@ferrite/node package root");
    cachedNodePackageManifest = await readJsonObject(
      join(packageRoot, "package.json"),
      "@ferrite/node package manifest",
      nodeRootInfo.canonical,
    );
  }
  return cachedNodePackageManifest;
}

async function readJsonObject(path, label, rootCanonical) {
  let value;
  try {
    const safePath = await assertRegularFile(path, label, rootCanonical);
    value = JSON.parse((await readVerifiedFile(safePath, label)).toString("utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid ${label}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: ${label} must be a JSON object.`);
  }
  return value;
}

async function readNonEmptyFile(path, label, rootCanonical) {
  const safePath = await assertRegularFile(path, label, rootCanonical);
  const file = await readVerifiedFile(safePath, label);
  if (file.length === 0) throw new Error(`${path}: ${label} must be a non-empty file.`);
  return file;
}

async function assertDirectory(path, label) {
  const info = await inspectPath(path, label);
  if (!info.stat.isDirectory()) throw new Error(`${path}: ${label} must be a directory.`);
  return info;
}

async function assertRegularFile(path, label, rootCanonical) {
  const info = await inspectPath(path, label, rootCanonical);
  if (!info.stat.isFile()) throw new Error(`${path}: ${label} must be a regular file.`);
  return info;
}

async function readVerifiedFile(info, label) {
  if (!fsConstants.O_NOFOLLOW && process.platform === "win32") {
    throw new Error(`${info.lexical}: cannot safely open ${label}; no no-follow primitive is available on Windows.`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(info.canonical, flags);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${info.lexical}: ${label} must be a regular file.`);
    if (
      typeof info.stat.dev === "number" &&
      typeof info.stat.ino === "number" &&
      info.stat.dev !== 0 &&
      info.stat.ino !== 0 &&
      (openedStat.dev !== info.stat.dev || openedStat.ino !== info.stat.ino)
    ) {
      throw new Error(`${info.lexical}: ${label} changed during safe opening.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function inspectPath(path, label, rootCanonical) {
  const lexical = resolve(path);
  let fileStat;
  try {
    fileStat = await lstat(lexical);
  } catch (error) {
    throw new Error(`${lexical}: invalid ${label}: ${error instanceof Error ? error.message : String(error)}.`, {
      cause: error,
    });
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${lexical}: ${label} must not be a symlink or reparse point.`);
  }
  const canonical = await realpath(lexical);
  if (rootCanonical && !isWithin(rootCanonical, canonical)) {
    throw new Error(`${lexical}: ${label} resolves outside its canonical root.`);
  }
  return { lexical, canonical, stat: fileStat };
}

function isWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function assertArrayEquals(root, actual, expected, message) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual[0] !== expected[0]) {
    throw new Error(`${root}: package ${message}.`);
  }
}

function assertArrayIncludes(root, actual, value, field) {
  if (!Array.isArray(actual) || !actual.includes(value)) {
    throw new Error(`${root}: package ${field} must include ${value}.`);
  }
}

function parseArgs(args) {
  const directories = [];
  const expectedPackages = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expect") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--expect requires a package name.");
      }
      expectedPackages.push(value);
      index += 1;
    } else {
      directories.push(arg);
    }
  }
  return { directories, expectedPackages };
}

async function main() {
  const { directories, expectedPackages } = parseArgs(argv.slice(2));
  const resolvedDirectories = [];
  for (const directory of directories) {
    await assertDirectory(directory, "prebuild package root");
    const childDirs = await discoverPrebuildPackageDirs(directory);
    resolvedDirectories.push(...(childDirs.length > 0 ? childDirs : [directory]));
  }
  const results = await verifyPrebuildPackageDirs(resolvedDirectories, { expectedPackages });
  for (const result of results) {
    console.log(`Verified Ferrite native prebuild package ${result.packageName} at ${result.directory}`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
