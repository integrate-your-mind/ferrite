import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  arch as currentArch,
  argv,
  platform as currentPlatform,
} from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLI_CHECKSUM_ALGORITHM,
  cliTarget,
  isExactSemver,
  verifyChecksumManifest,
} from "../lib/cli-package.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const checksumFile = "ferrite-cli.sha256.json";

export async function createCliCandidate({
  binaryPath,
  destinationRoot = join(workspaceRoot, "dist", "cli-candidate"),
  platform = currentPlatform,
  arch = currentArch,
  renameImpl = rename,
  removeImpl = rm,
  writeFileImpl = writeFile,
} = {}) {
  if (!binaryPath) {
    throw new Error("Ferrite CLI candidate creation requires --binary.");
  }

  const target = cliTarget({ platform, arch });
  if (!target) {
    throw new Error(
      `No verified Ferrite CLI npm target exists for ${platform}/${arch}.`,
    );
  }

  const sourceManifest = parseJson(
    await readRegularFile(join(packageRoot, "package.json"), "CLI package manifest"),
    "CLI package manifest",
  );
  if (sourceManifest.name !== "@ferrite/cli" || sourceManifest.private !== true) {
    throw new Error("CLI source manifest must be private @ferrite/cli.");
  }
  assertExactVersion(sourceManifest.version, "CLI package manifest");

  const binary = await readRegularFile(resolve(binaryPath), "Ferrite CLI binary", {
    executable: platform !== "win32",
  });
  const wrapperFiles = new Map([
    [
      "bin/ferrite.mjs",
      await readRegularFile(join(packageRoot, "bin", "ferrite.mjs"), "CLI launcher"),
    ],
    [
      "lib/cli-package.js",
      await readRegularFile(
        join(packageRoot, "lib", "cli-package.js"),
        "CLI resolver",
      ),
    ],
  ]);

  const destination = resolve(destinationRoot);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const destinationParent = await assertRealDirectory(
    dirname(destination),
    "CLI candidate parent",
  );
  const canonicalDestination = join(destinationParent, basename(destination));

  const staging = join(
    destinationParent,
    `.${destination.split(/[\\/]/).pop()}.staging-${process.pid}-${randomUUID()}`,
  );
  let stagingLive = false;
  let operationError;
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    stagingLive = true;

    const wrapperDirectory = join(staging, "cli");
    const platformDirectory = join(
      staging,
      target.packageName.replace("@ferrite/", ""),
    );
    await mkdir(join(wrapperDirectory, "bin"), { recursive: true, mode: 0o700 });
    await mkdir(join(wrapperDirectory, "lib"), { recursive: true, mode: 0o700 });
    await mkdir(join(platformDirectory, "bin"), { recursive: true, mode: 0o700 });

    for (const [relativePath, bytes] of wrapperFiles) {
      await writeExclusive(
        join(wrapperDirectory, relativePath),
        bytes,
        relativePath.startsWith("bin/") ? 0o755 : 0o644,
        writeFileImpl,
      );
    }

    const wrapperManifest = structuredClone(sourceManifest);
    delete wrapperManifest.private;
    delete wrapperManifest.scripts;
    wrapperManifest.optionalDependencies = {
      [target.packageName]: sourceManifest.version,
    };
    await writeExclusive(
      join(wrapperDirectory, "package.json"),
      jsonBytes(wrapperManifest),
      0o644,
      writeFileImpl,
    );

    const platformManifest = {
      name: target.packageName,
      version: sourceManifest.version,
      description: `Ferrite Rust CLI binary for ${platform}/${arch}.`,
      license: sourceManifest.license,
      repository: sourceManifest.repository,
      homepage: sourceManifest.homepage,
      bugs: sourceManifest.bugs,
      engines: sourceManifest.engines,
      publishConfig: sourceManifest.publishConfig,
      os: [target.os],
      cpu: [target.cpu],
      files: ["bin", checksumFile],
      exports: {
        [`./${target.binaryFile}`]: `./${target.binaryFile}`,
        [`./${checksumFile}`]: `./${checksumFile}`,
        "./package.json": "./package.json",
      },
    };
    const checksumManifest = {
      file: target.binaryFile,
      algorithm: CLI_CHECKSUM_ALGORITHM,
      packageVersion: sourceManifest.version,
      bytes: binary.length,
      sha256: createHash(CLI_CHECKSUM_ALGORITHM).update(binary).digest("hex"),
    };
    await writeExclusive(
      join(platformDirectory, target.binaryFile),
      binary,
      platform === "win32" ? 0o644 : 0o755,
      writeFileImpl,
    );
    await writeExclusive(
      join(platformDirectory, checksumFile),
      jsonBytes(checksumManifest),
      0o644,
      writeFileImpl,
    );
    await writeExclusive(
      join(platformDirectory, "package.json"),
      jsonBytes(platformManifest),
      0o644,
      writeFileImpl,
    );

    await verifyCliCandidate(staging, { platform, arch });
    await publishCandidate(staging, canonicalDestination, { renameImpl, removeImpl });
    stagingLive = false;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (stagingLive) {
      try {
        await removeImpl(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, cleanupError],
            `CLI candidate creation failed and staging cleanup also failed at ${staging}.`,
          );
        }
        throw cleanupError;
      }
    }
  }

  return {
    root: destination,
    wrapperDirectory: join(destination, "cli"),
    platformDirectory: join(
      destination,
      target.packageName.replace("@ferrite/", ""),
    ),
    packageVersion: sourceManifest.version,
    platformPackage: target.packageName,
  };
}

export async function verifyCliCandidate(
  candidateRoot,
  { platform = currentPlatform, arch = currentArch } = {},
) {
  const target = cliTarget({ platform, arch });
  if (!target) {
    throw new Error(
      `No verified Ferrite CLI npm target exists for ${platform}/${arch}.`,
    );
  }

  const root = await assertRealDirectory(resolve(candidateRoot), "CLI candidate");
  const expectedRootEntries = [
    "cli",
    target.packageName.replace("@ferrite/", ""),
  ].sort();
  assertExactEntries(
    await readdir(root),
    expectedRootEntries,
    "CLI candidate root",
  );

  const wrapperDirectory = join(root, "cli");
  const platformDirectory = join(
    root,
    target.packageName.replace("@ferrite/", ""),
  );
  await assertRealDirectory(wrapperDirectory, "CLI wrapper package");
  await assertRealDirectory(platformDirectory, "CLI platform package");
  await assertTree(
    wrapperDirectory,
    ["bin/ferrite.mjs", "lib/cli-package.js", "package.json"],
    "CLI wrapper package",
  );
  await assertTree(
    platformDirectory,
    [target.binaryFile, checksumFile, "package.json"],
    "CLI platform package",
  );

  const wrapperManifest = parseJson(
    await readRegularFile(
      join(wrapperDirectory, "package.json"),
      "CLI wrapper manifest",
    ),
    "CLI wrapper manifest",
  );
  const platformManifest = parseJson(
    await readRegularFile(
      join(platformDirectory, "package.json"),
      "CLI platform manifest",
    ),
    "CLI platform manifest",
  );
  if (wrapperManifest.name !== "@ferrite/cli") {
    throw new Error("CLI wrapper candidate must be named @ferrite/cli.");
  }
  if (Object.hasOwn(wrapperManifest, "private")) {
    throw new Error("CLI wrapper candidate must not contain private.");
  }
  assertExactVersion(wrapperManifest.version, "CLI wrapper manifest");
  if (
    Object.keys(wrapperManifest.optionalDependencies ?? {}).length !== 1 ||
    wrapperManifest.optionalDependencies?.[target.packageName] !==
      wrapperManifest.version
  ) {
    throw new Error(
      `CLI wrapper must depend optionally on exact ${target.packageName}@${wrapperManifest.version}.`,
    );
  }
  if (
    platformManifest.name !== target.packageName ||
    platformManifest.version !== wrapperManifest.version ||
    platformManifest.os?.length !== 1 ||
    platformManifest.os[0] !== target.os ||
    platformManifest.cpu?.length !== 1 ||
    platformManifest.cpu[0] !== target.cpu
  ) {
    throw new Error("CLI platform manifest does not match the wrapper target contract.");
  }

  const binaryPath = join(platformDirectory, target.binaryFile);
  const binary = await readRegularFile(binaryPath, "CLI candidate binary", {
    executable: platform !== "win32",
  });
  const checksumManifest = parseJson(
    await readRegularFile(
      join(platformDirectory, checksumFile),
      "CLI checksum manifest",
    ),
    "CLI checksum manifest",
  );
  verifyChecksumManifest(checksumManifest, {
    binary,
    binaryFile: target.binaryFile,
    packageName: target.packageName,
    packageVersion: wrapperManifest.version,
  });

  return {
    packageVersion: wrapperManifest.version,
    platformPackage: target.packageName,
    binaryPath,
    sha256: checksumManifest.sha256,
    bytes: checksumManifest.bytes,
  };
}

async function publishCandidate(staging, destination, { renameImpl, removeImpl }) {
  const destinationInfo = await lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (destinationInfo?.isSymbolicLink()) {
    throw new Error(`CLI candidate destination must not be a symbolic link: ${destination}.`);
  }

  const backup = `${destination}.backup-${process.pid}-${randomUUID()}`;
  let priorMoved = false;
  try {
    if (destinationInfo) {
      await renameImpl(destination, backup);
      priorMoved = true;
    }
    await renameImpl(staging, destination);
  } catch (error) {
    if (priorMoved) {
      try {
        await renameImpl(backup, destination);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `CLI candidate publication failed and rollback also failed. Prior output remains at ${backup}.`,
        );
      }
    }
    throw error;
  }

  if (priorMoved) {
    try {
      await removeImpl(backup, { recursive: true, force: true });
    } catch (error) {
      throw new Error(
        `CLI candidate published at ${destination}, but prior output remains at ${backup}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

async function readRegularFile(path, label, { executable = false } = {}) {
  const info = await lstat(path).catch((error) => {
    throw new Error(`${label} was not found at ${path}: ${error.message}`, {
      cause: error,
    });
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file: ${path}.`);
  }
  if (executable && (info.mode & 0o111) === 0) {
    throw new Error(`${label} must be executable: ${path}.`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`${label} changed while it was being opened: ${path}.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path).catch((error) => {
    throw new Error(`${label} was not found at ${path}: ${error.message}`, {
      cause: error,
    });
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}.`);
  }
  return realpath(path);
}

async function assertTree(root, expectedFiles, label) {
  const discovered = [];
  async function walk(directory, prefix = "") {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links: ${relativePath}.`);
      }
      if (info.isDirectory()) {
        await walk(path, relativePath);
      } else if (info.isFile()) {
        discovered.push(relativePath);
      } else {
        throw new Error(`${label} contains unsupported entry ${relativePath}.`);
      }
    }
  }
  await walk(root);
  assertExactEntries(discovered, [...expectedFiles].sort(), label);
}

function assertExactEntries(actual, expected, label) {
  const sorted = [...actual].sort();
  if (
    sorted.length !== expected.length ||
    sorted.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `${label} must contain exactly ${expected.join(", ")}; found ${sorted.join(", ")}.`,
    );
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`, { cause: error });
  }
}

function assertExactVersion(value, label) {
  if (!isExactSemver(value)) {
    throw new Error(`${label} must include an exact semantic version.`);
  }
}

async function writeExclusive(path, bytes, mode, writeFileImpl) {
  await writeFileImpl(path, bytes, { flag: "wx", mode });
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--binary" || value === "--out") {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(argv.slice(2));
  const result = await createCliCandidate({
    binaryPath: options.binary,
    destinationRoot: options.out,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  argv[1] &&
  import.meta.url === pathToFileURL(resolve(argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
