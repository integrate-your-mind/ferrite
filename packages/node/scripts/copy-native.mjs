import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const execFile = promisify(execFileCallback);
const darwinAdHocIdentifier = "ferrite-node";

export async function copyNativeBinding({
  source = join(cargoTargetRoot(), process.env.PROFILE || "debug", nativeLibraryName()),
  destination = join(packageRoot, "dist", "ferrite-node.node"),
  platformName = platform,
  copyFileImpl = copyFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
  removeImpl = rm,
  signDarwinImpl = signDarwinNativeBinding,
  stagingPathFactory = (path) => `${path}.${process.pid}.${randomUUID()}.staged`,
  statImpl = stat,
  logger = console,
} = {}) {
  await statImpl(source).catch((error) => {
    throw new Error(
      `Ferrite native library was not found at ${source}. Run \`cargo build -p ferrite-node\` first. ${error.message}`,
    );
  });

  await mkdirImpl(dirname(destination), { recursive: true });

  if (platformName === "darwin") {
    const staging = stagingPathFactory(destination);
    try {
      await copyFileImpl(source, staging);
      await signDarwinImpl(staging);
      await renameImpl(staging, destination);
    } catch (error) {
      let cleanupError;
      try {
        await removeImpl(staging, { force: true });
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      const cleanupMessage = cleanupError
        ? ` Cleanup of ${staging} also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}.`
        : "";
      throw new Error(
        `Ferrite could not stage and ad-hoc sign the copied macOS native binding for ${destination}: ${error instanceof Error ? error.message : String(error)}.${cleanupMessage}`,
        { cause: error },
      );
    }
  } else {
    await copyFileImpl(source, destination);
  }

  logger.log(`Ferrite native binding copied to ${destination}`);
  return destination;
}

export async function signDarwinNativeBinding(destination, { execFileImpl = execFile } = {}) {
  // The fixed identifier keeps the UUID staging filename out of the signed bytes.
  // This only restores loader validity; release signing and notarization stay separate.
  await execFileImpl(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      darwinAdHocIdentifier,
      "--timestamp=none",
      destination,
    ],
    { encoding: "utf8" },
  );
}

function cargoTargetRoot() {
  const configured = process.env.CARGO_TARGET_DIR;
  if (!configured) {
    return join(workspaceRoot, "target");
  }
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function nativeLibraryName() {
  switch (platform) {
    case "darwin":
      return "libferrite_node.dylib";
    case "win32":
      return "ferrite_node.dll";
    default:
      return "libferrite_node.so";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await copyNativeBinding();
}
