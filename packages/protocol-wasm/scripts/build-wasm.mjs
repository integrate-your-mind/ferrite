import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const target = "wasm32-unknown-unknown";
const profile = env.PROFILE || "debug";
const targetRoot = cargoTargetRoot();
const source = join(targetRoot, target, profile, "ferrite_protocol_wasm.wasm");
const outDir = join(packageRoot, "dist");
const destination = join(outDir, "ferrite_protocol_wasm.wasm");
const rustupTools = await rustupToolchainExecutables();
const cargo = env.CARGO || rustupTools.cargo || "cargo";
const rustc = env.RUSTC || rustupTools.rustc;

await execFileAsync(
  cargo,
  ["build", "-p", "ferrite-protocol-wasm", "--target", target],
  {
    cwd: workspaceRoot,
    env: rustc ? { ...env, RUSTC: rustc } : env,
    maxBuffer: 1024 * 1024,
  },
);
await stat(source).catch((error) => {
  throw new Error(
    `Ferrite protocol WASM artifact was not found at ${source}. ${error.message}`,
  );
});
await mkdir(outDir, { recursive: true });
await copyFile(source, destination);
console.log(`Ferrite protocol WASM copied to ${destination}`);

function cargoTargetRoot() {
  const configured = env.CARGO_TARGET_DIR;
  if (!configured) {
    return join(workspaceRoot, "target");
  }
  return isAbsolute(configured) ? configured : resolve(workspaceRoot, configured);
}

async function rustupToolchainExecutables() {
  try {
    const [cargo, rustc] = await Promise.all([
      rustupWhich("cargo"),
      rustupWhich("rustc"),
    ]);
    return { cargo, rustc };
  } catch {
    return {};
  }
}

async function rustupWhich(tool) {
  const { stdout } = await execFileAsync("rustup", ["which", tool], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
