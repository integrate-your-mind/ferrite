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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { arch as currentArch, argv, platform as currentPlatform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nativePrebuildPackageName } from "../binding.js";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checksumFile = "ferrite-node.sha256.json";
const bindingFile = "ferrite-node.node";

/**
 * Build a prebuild in a private sibling and publish it only after all three
 * package files have been checked.  The fs hooks are intentionally small so
 * failure/rollback paths can be exercised without a partial real build.
 */
export async function createPrebuildPackage({
  packageRoot = defaultPackageRoot,
  destinationRoot = join(packageRoot, "dist", "prebuild"),
  platform = currentPlatform,
  arch = currentArch,
  lstatImpl = lstat,
  mkdirImpl = mkdir,
  openImpl = open,
  realpathImpl = realpath,
  renameImpl = rename,
  removeImpl = rm,
  writeFileImpl = writeFile,
} = {}) {
  const packageRootPath = resolve(packageRoot);
  const destinationPath = resolve(destinationRoot);
  const packageName = nativePrebuildPackageName({ platform, arch });
  if (!packageName) {
    throw new Error(`No Ferrite native prebuild package mapping exists for ${platform}/${arch}.`);
  }
  const packageRootInfo = await assertDirectory(packageRootPath, "package root", {
    lstatImpl,
    realpathImpl,
  });
  const packageRootCanonical = packageRootInfo.canonical;
  await inspectOptionalDirectory(join(packageRootPath, "dist"), "native dist directory", {
    rootCanonical: packageRootCanonical,
    lstatImpl,
    realpathImpl,
  });
  const packageManifestPath = await assertRegularFile(
    join(packageRootPath, "package.json"),
    "package manifest",
    { rootCanonical: packageRootCanonical, lstatImpl, realpathImpl },
  );
  const bindingPath = await assertRegularFile(
    join(packageRootPath, "dist", bindingFile),
    "native binding",
    { rootCanonical: packageRootCanonical, lstatImpl, realpathImpl },
  ).catch((error) => {
    throw new Error(
      `Ferrite native binding was not found at ${join(packageRootPath, "dist", bindingFile)}. Run \`pnpm --filter @ferrite/node build\` first. ${error.message}`,
      { cause: error },
    );
  });
  const nodePackage = JSON.parse(
    (await readVerifiedFile(packageManifestPath, "package manifest", { openImpl })).toString("utf8"),
  );
  const bindingBytes = await readVerifiedFile(bindingPath, "native binding", { openImpl });
  const checksum = createHash("sha256").update(bindingBytes).digest("hex");
  const manifest = {
    name: packageName,
    version: nodePackage.version,
    description: `Ferrite native Node.js binding for ${platform}/${arch}.`,
    license: nodePackage.license,
    keywords: nodePackage.keywords,
    repository: nodePackage.repository,
    homepage: nodePackage.homepage,
    bugs: nodePackage.bugs,
    engines: nodePackage.engines,
    publishConfig: {
      access: "public",
    },
    os: [platform],
    cpu: [arch],
    files: [bindingFile, checksumFile],
    exports: {
      [`./${bindingFile}`]: `./${bindingFile}`,
      [`./${checksumFile}`]: `./${checksumFile}`,
    },
  };
  const checksumManifest = {
    file: bindingFile,
    algorithm: "sha256",
    sha256: checksum,
  };
  const checksumManifestBytes = Buffer.from(`${JSON.stringify(checksumManifest, null, 2)}\n`);
  const packageManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

  const destinationParent = await assertDirectory(dirname(destinationPath), "destination parent", {
    lstatImpl,
    realpathImpl,
  });
  const destinationInfo = await inspectOptionalDirectory(destinationPath, "destination", {
    rootCanonical: destinationParent.canonical,
    lstatImpl,
    realpathImpl,
  });
  if (destinationInfo) {
    await rejectExistingArtifactSymlinks(destinationInfo.canonical, {
      lstatImpl,
      realpathImpl,
    });
  }

  const stagingPath = join(
    destinationParent.canonical,
    `.${destinationPath.split(/[\\/]/).pop() || "prebuild"}.staging-${process.pid}-${randomUUID()}`,
  );
  let stagingCanonical;
  let operationError;
  try {
    await mkdirImpl(stagingPath, { recursive: false, mode: 0o700 });
    stagingCanonical = (
      await assertDirectory(stagingPath, "prebuild staging directory", {
        lstatImpl,
        realpathImpl,
        rootCanonical: destinationParent.canonical,
      })
    ).canonical;

    await writeClosed(
      join(stagingCanonical, bindingFile),
      bindingBytes,
      writeFileImpl,
    );
    await writeClosed(
      join(stagingCanonical, checksumFile),
      checksumManifestBytes,
      writeFileImpl,
    );
    await writeClosed(
      join(stagingCanonical, "package.json"),
      packageManifestBytes,
      writeFileImpl,
    );

    await verifyStagingSet(stagingCanonical, {
      expectedChecksum: checksum,
      expectedChecksumManifest: checksumManifestBytes,
      expectedPackageManifest: packageManifestBytes,
      lstatImpl,
      realpathImpl,
      openImpl,
      rootCanonical: stagingCanonical,
    });
    await publishStaging({
      stagingCanonical,
      destinationCanonical: destinationInfo?.canonical ?? join(destinationParent.canonical, destinationPath.split(/[\\/]/).pop()),
      renameImpl,
      removeImpl,
      lstatImpl,
    });
    stagingCanonical = undefined;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (stagingCanonical) {
      try {
        await removeImpl(stagingCanonical, { recursive: true, force: true });
      } catch (cleanupError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, cleanupError],
            `Ferrite native prebuild creation failed and private staging cleanup also failed at ${stagingCanonical}.`,
          );
        }
        throw cleanupError;
      }
    }
  }

  return {
    directory: destinationPath,
    packageName,
  };
}

async function publishStaging({ stagingCanonical, destinationCanonical, renameImpl, removeImpl, lstatImpl }) {
  const destinationStat = await lstatImpl(destinationCanonical).then((value) => value).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  const destinationExists = Boolean(destinationStat);
  if (destinationStat?.isSymbolicLink()) {
    throw new Error(`${destinationCanonical}: destination must not be a symlink or reparse point.`);
  }
  const backup = `${destinationCanonical}.${process.pid}.${randomUUID()}.backup`;
  let movedExisting = false;
  try {
    if (destinationExists) {
      await renameImpl(destinationCanonical, backup);
      movedExisting = true;
    }
    await renameImpl(stagingCanonical, destinationCanonical);
  } catch (error) {
    if (movedExisting) {
      try {
        await renameImpl(backup, destinationCanonical);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Ferrite native prebuild publication failed; rollback also failed. The prior output is preserved at ${backup} and the destination is ${destinationCanonical}.`,
        );
      }
    }
    throw error;
  }
  if (movedExisting) {
    try {
      await removeImpl(backup, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `Ferrite native prebuild published at ${destinationCanonical}, but the recoverable prior output remains at ${backup}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
  }
}

async function verifyStagingSet(root, {
  expectedChecksum,
  expectedChecksumManifest,
  expectedPackageManifest,
  ...options
}) {
  const names = (await readdir(root)).sort();
  const expectedNames = [bindingFile, checksumFile, "package.json"].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`${root}: generated prebuild must contain exactly ${expectedNames.join(", ")}.`);
  }
  const binding = await readSafeFile(join(root, bindingFile), "native binding", options);
  const checksumPath = await assertRegularFile(join(root, checksumFile), "checksum manifest", {
    rootCanonical: root,
    ...options,
  });
  const checksumManifestBytes = await readVerifiedFile(
    checksumPath,
    "checksum manifest",
    options,
  );
  const manifestPath = await assertRegularFile(join(root, "package.json"), "package manifest", {
    rootCanonical: root,
    ...options,
  });
  const packageManifestBytes = await readVerifiedFile(manifestPath, "package manifest", options);
  if (
    !checksumManifestBytes.equals(expectedChecksumManifest) ||
    !packageManifestBytes.equals(expectedPackageManifest) ||
    createHash("sha256").update(binding).digest("hex") !== expectedChecksum
  ) {
    throw new Error(`${root}: generated prebuild artifact set did not verify byte-for-byte.`);
  }
}

async function writeClosed(path, data, writeFileImpl) {
  // writeFile opens, writes, and closes the file before resolving.  wx also
  // prevents a pre-existing substitution from being followed in staging.
  await writeFileImpl(path, data, { flag: "wx", mode: 0o600 });
}

async function rejectExistingArtifactSymlinks(root, options) {
  for (const name of [bindingFile, checksumFile, "package.json"]) {
    const path = join(root, name);
    const info = await inspectOptional(path, name, { ...options, rootCanonical: root });
    if (info?.stat.isSymbolicLink()) {
      throw new Error(`${path}: ${name} must not be a symlink or reparse point.`);
    }
  }
}

async function assertDirectory(path, label, options) {
  const info = await inspectPath(path, label, options);
  if (!info.stat.isDirectory()) throw new Error(`${path}: ${label} must be a directory.`);
  return info;
}

async function inspectOptionalDirectory(path, label, options) {
  const info = await inspectOptional(path, label, options);
  if (info && !info.stat.isDirectory()) throw new Error(`${path}: ${label} must be a directory.`);
  return info;
}

async function assertRegularFile(path, label, options) {
  const info = await inspectPath(path, label, options);
  if (!info.stat.isFile()) throw new Error(`${path}: ${label} must be a regular file.`);
  return info;
}

async function readSafeFile(path, label, options) {
  const info = await assertRegularFile(path, label, options);
  return readVerifiedFile(info, label, options);
}

async function readVerifiedFile(info, label, { openImpl = open }) {
  if (!fsConstants.O_NOFOLLOW && process.platform === "win32") {
    throw new Error(`${info.lexical}: cannot safely open ${label}; no no-follow primitive is available on Windows.`);
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await openImpl(info.canonical, flags);
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

async function inspectPath(path, label, { rootCanonical, lstatImpl, realpathImpl }) {
  const lexical = resolve(path);
  const stat = await lstatImpl(lexical).catch((error) => {
    throw new Error(`${lexical}: ${label} could not be inspected: ${error.message}`, { cause: error });
  });
  if (stat.isSymbolicLink()) {
    throw new Error(`${lexical}: ${label} must not be a symlink or reparse point.`);
  }
  const canonical = await realpathImpl(lexical);
  if (rootCanonical && !isWithin(rootCanonical, canonical)) {
    throw new Error(`${lexical}: ${label} resolves outside its canonical root.`);
  }
  return { lexical, canonical, stat };
}

async function inspectOptional(path, label, options) {
  try {
    return await inspectPath(path, label, options);
  } catch (error) {
    if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function isWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function main() {
  const destinationRoot = argv[2] ? resolve(argv[2]) : join(defaultPackageRoot, "dist", "prebuild");
  const result = await createPrebuildPackage({ destinationRoot });
  console.log(`Ferrite native prebuild package ${result.packageName} written to ${result.directory}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
