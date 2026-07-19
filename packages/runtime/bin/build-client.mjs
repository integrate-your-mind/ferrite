#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [, , pageFile, outDirArg, publicPathArg, routePath = "/", propsJson = "{}", layoutsJson = "[]", optionsJson = "{}"] =
  process.argv;

if (!pageFile || !outDirArg || !publicPathArg) {
  console.error(
    "usage: build-client <page-file> <out-dir> <public-path> [route-path] [props-json] [layouts-json] [options-json]",
  );
  process.exit(2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const baseScript = join(scriptDir, "build-client-base.mjs");
const requestedOutDir = resolve(outDirArg);
const parent = dirname(requestedOutDir);
await mkdir(parent, { recursive: true });
await mkdir(requestedOutDir, { recursive: true });
const tempRoot = await mkdtemp(join(parent, ".ferrite-entry-name-build-"));
const tempOutDir = join(tempRoot, "out");
await mkdir(tempOutDir, { recursive: true });

try {
  const hashedRoutePath = entryIdentityRoutePath(routePath);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      baseScript,
      pageFile,
      tempOutDir,
      publicPathArg,
      hashedRoutePath,
      propsJson,
      layoutsJson,
      optionsJson,
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (stderr) {
    process.stderr.write(stderr);
  }

  const response = parseBaseResponse(stdout);
  assertDistinctClientReferenceOutputs(response.clientReferences ?? []);
  await publishOutputs(tempOutDir, requestedOutDir, response.outputs ?? []);
  await writeResponse(response);
} catch (error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr || "") : "";
  if (stderr) {
    process.stderr.write(stderr);
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = typeof error?.code === "number" && error.code > 0 ? error.code : 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function entryIdentityRoutePath(route) {
  const readable = route
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "index";
  const digest = createHash("sha256").update(route).digest("hex").slice(0, 16);
  return `/${readable}/${digest}`;
}

function parseBaseResponse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new TypeError(
      `Ferrite client bundler returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertDistinctClientReferenceOutputs(references) {
  const owners = new Map();
  for (const reference of references) {
    if (typeof reference.script !== "string" || reference.script.length === 0) {
      throw new Error(`Ferrite client reference ${JSON.stringify(reference.id)} is missing its generated script.`);
    }
    const previous = owners.get(reference.script);
    if (previous && previous !== reference.id) {
      throw new Error(
        `Ferrite generated client-reference output collision: ${JSON.stringify(previous)} and ${JSON.stringify(reference.id)} both map to ${JSON.stringify(reference.script)}.`,
      );
    }
    owners.set(reference.script, reference.id);
  }
}

async function publishOutputs(sourceRootInput, destinationRootInput, outputs) {
  await mkdir(destinationRootInput, { recursive: true });
  const sourceRoot = await realpath(sourceRootInput);
  const destinationRoot = await realpath(destinationRootInput);
  const pendingRoot = await realpath(await mkdtemp(join(destinationRoot, ".ferrite-entry-publish-")));
  try {
    for (const [index, output] of [...new Set(outputs)].entries()) {
      if (typeof output !== "string" || output.length === 0 || isAbsolute(output) || output.includes("..")) {
        throw new Error(`Ferrite generated output path is invalid: ${String(output)}`);
      }
      const source = resolve(sourceRoot, output);
      const destination = resolve(destinationRoot, output);
      if (!isInside(sourceRoot, source) || !isInside(destinationRoot, destination)) {
        throw new Error(`Ferrite generated output escapes its build directory: ${output}`);
      }
      const sourceInfo = await lstat(source);
      const canonicalSource = await realpath(source);
      if (!sourceInfo.isFile() || canonicalSource !== source) {
        throw new Error(`Ferrite generated output is not a regular file: ${output}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      const destinationParent = await realpath(dirname(destination));
      if (destinationParent !== destinationRoot && !isInside(destinationRoot, destinationParent)) {
        throw new Error(`Ferrite generated output directory escapes its build directory: ${output}`);
      }
      try {
        const existing = await lstat(destination);
        if (!existing.isFile()) {
          throw new Error(`Ferrite generated output destination is not a regular file: ${output}`);
        }
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") {
          throw error;
        }
      }
      const pending = join(pendingRoot, `${index}-${basename(output)}`);
      await copyFile(source, pending, constants.COPYFILE_EXCL);
      await rename(pending, destination);
    }
  } finally {
    await rm(pendingRoot, { recursive: true, force: true });
  }
}

function isInside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix.length > 0 && !suffix.startsWith("..") && !isAbsolute(suffix);
}

async function writeResponse(response) {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}
