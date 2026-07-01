import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const targetRoot = cargoTargetRoot();
const profile = process.env.PROFILE || "debug";
const source = join(targetRoot, profile, nativeLibraryName());
const outDir = join(packageRoot, "dist");
const destination = join(outDir, "ferrite-node.node");

await stat(source).catch((error) => {
  throw new Error(
    `Ferrite native library was not found at ${source}. Run \`cargo build -p ferrite-node\` first. ${error.message}`,
  );
});
await mkdir(outDir, { recursive: true });
await copyFile(source, destination);
console.log(`Ferrite native binding copied to ${destination}`);

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
