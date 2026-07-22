import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const execFile = promisify(execFileCallback);

export async function copyNativeBinding({
  source = join(cargoTargetRoot(), process.env.PROFILE || "debug", nativeLibraryName()),
  destination = join(packageRoot, "dist", "ferrite-node.node"),
  platformName = platform,
  copyFileImpl = copyFile,
  mkdirImpl = mkdir,
  removeImpl = rm,
  signDarwinImpl = signDarwinNativeBinding,
  statImpl = stat,
  logger = console,
} = {}) {
  await statImpl(source).catch((error) => {
    throw new Error(
      `Ferrite native library was not found at ${source}. Run \`cargo build -p ferrite-node\` first. ${error.message}`,
    );
  });

  await mkdirImpl(dirname(destination), { recursive: true });
  await copyFileImpl(source, destination);

  if (platformName === "darwin") {
    try {
      await signDarwinImpl(destination);
    } catch (error) {
      await removeImpl(destination, { force: true }).catch(() => {});
      throw new Error(
        `Ferrite could not ad-hoc sign the copied macOS native binding at ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  logger.log(`Ferrite native binding copied to ${destination}`);
  return destination;
}

export async function signDarwinNativeBinding(destination, { execFileImpl = execFile } = {}) {
  // This restores loader validity after copying; release identity signing and notarization stay separate.
  await execFileImpl(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", "--timestamp=none", destination],
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
