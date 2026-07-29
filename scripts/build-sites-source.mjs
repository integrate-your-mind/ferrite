import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SITE_ORIGIN = "https://ferrite.mondello.dev";
export const RUST_TOOLCHAIN = "1.95.0";
export const RUSTUP_INIT_URL =
  "https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init";
export const RUSTUP_INIT_SHA256 =
  "20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c";
export const RUSTUP_TARGET = "x86_64-unknown-linux-gnu";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = join(root, "node_modules", "typescript", "bin", "tsc");
const website = join(root, "website");
const websiteDist = join(website, "dist");
const outputDist = join(root, "dist");
const rustupMaximumBytes = 32 * 1024 * 1024;
const rustupInstallTimeoutMs = 5 * 60_000;

export function siteOrigin(value = DEFAULT_SITE_ORIGIN) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "FERRITE_SITE_ORIGIN must be an HTTPS origin without credentials, a path, query, or fragment",
    );
  }
  return url.origin;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function rustBootstrapSupported(
  platform = process.platform,
  arch = process.arch,
) {
  return platform === "linux" && arch === "x64";
}

export function buildPlan(cargo = "cargo") {
  return [
    {
      command: process.execPath,
      args: [typescript, "-p", join(root, "packages", "protocol", "tsconfig.json")],
      timeoutMs: 2 * 60_000,
    },
    {
      command: process.execPath,
      args: [typescript, "-p", join(root, "packages", "runtime", "tsconfig.json")],
      timeoutMs: 2 * 60_000,
    },
    {
      command: cargo,
      args: [
        "run",
        "--locked",
        "--manifest-path",
        join(root, "Cargo.toml"),
        "-p",
        "ferrite-cli",
        "--",
        "build",
        "--project",
        website,
        "--page-renderer",
        join(root, "packages", "runtime", "bin", "render-page.mjs"),
        "--client-bundler",
        join(root, "packages", "runtime", "bin", "build-client.mjs"),
      ],
      timeoutMs: 15 * 60_000,
    },
    {
      command: process.execPath,
      args: [join(website, "deploy-adapter.mjs")],
      timeoutMs: 2 * 60_000,
    },
  ];
}

function terminate(child, detached, signal) {
  try {
    if (detached && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function run(command, args, env, timeoutMs = 2 * 60_000) {
  await new Promise((accept, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: root,
      detached,
      env,
      stdio: "inherit",
    });
    let settled = false;
    let timeoutError = null;
    let killTimer = null;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${command} timed out after ${timeoutMs}ms`);
      try {
        terminate(child, detached, "SIGTERM");
      } catch (error) {
        timeoutError = new Error(`${timeoutError.message}; termination failed: ${error.message}`);
      }
      killTimer = setTimeout(() => {
        try {
          terminate(child, detached, "SIGKILL");
        } catch (error) {
          timeoutError = new Error(`${timeoutError.message}; forced termination failed: ${error.message}`);
        }
        finish(timeoutError);
      }, 5_000);
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else accept();
    };
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (timeoutError) {
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`),
      );
    });
  });
}

export async function commandAvailable(command, env) {
  const result = spawnSync(command, ["--version"], {
    cwd: root,
    env,
    stdio: "ignore",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ENOENT") return false;
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  throw new Error(`${command} --version failed with exit code ${result.status}`);
}

export async function readBoundedBody(response, maximumBytes = rustupMaximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("pinned rustup-init response has no body");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new Error("pinned rustup-init download exceeds the size limit");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {}
    throw error;
  }
}

function rustEnvironment(baseEnv, toolRoot) {
  const env = { ...baseEnv };
  for (const key of [
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CARGO_ENCODED_RUSTFLAGS",
    "RUSTC",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTFLAGS",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    CARGO_HOME: join(toolRoot, "cargo"),
    CARGO_TARGET_DIR: join(toolRoot, "target"),
    RUSTUP_AUTO_INSTALL: "0",
    RUSTUP_DIST_SERVER: "https://static.rust-lang.org",
    RUSTUP_HOME: join(toolRoot, "rustup"),
    RUSTUP_NO_UPDATE_CHECK: "1",
    RUSTUP_TOOLCHAIN: `${RUST_TOOLCHAIN}-${RUSTUP_TARGET}`,
    RUSTUP_UPDATE_ROOT: "https://static.rust-lang.org/rustup",
  };
}

export async function bootstrapCargo(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!rustBootstrapSupported(platform, arch)) {
    throw new Error(
      "the pinned Sites Rust bootstrap supports only x86_64 Linux",
    );
  }
  const sourceRoot = options.sourceRoot ?? root;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const rmImpl = options.rmImpl ?? rm;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const runImpl = options.runImpl ?? run;
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectedSha256 = options.expectedSha256 ?? RUSTUP_INIT_SHA256;
  const rustupUrl = options.rustupUrl ?? RUSTUP_INIT_URL;
  const maximumBytes = options.maximumBytes ?? rustupMaximumBytes;
  const scratchRoot = join(sourceRoot, ".ferrite");
  await mkdirImpl(scratchRoot, { recursive: true });
  const toolRoot = await mkdtempImpl(join(scratchRoot, "sites-rust-"));
  const cargoHome = join(toolRoot, "cargo");
  const rustupInit = join(toolRoot, "rustup-init");
  const env = rustEnvironment(options.env ?? process.env, toolRoot);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rmImpl(toolRoot, { recursive: true, force: true });
  };
  try {
    const response = await fetchImpl(rustupUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || response.url !== rustupUrl) {
      throw new Error(
        `pinned rustup-init download failed with HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > maximumBytes
    ) {
      throw new Error("pinned rustup-init download exceeds the size limit");
    }
    const bytes = await readBoundedBody(response, maximumBytes);
    if (bytes.length === 0) {
      throw new Error("pinned rustup-init download has an invalid size");
    }
    if (sha256(bytes) !== expectedSha256) {
      throw new Error("pinned rustup-init checksum mismatch");
    }
    await writeFileImpl(rustupInit, bytes, { mode: 0o700 });
    await runImpl(
      rustupInit,
      [
        "-y",
        "--no-modify-path",
        "--profile",
        "minimal",
        "--default-host",
        RUSTUP_TARGET,
        "--default-toolchain",
        `${RUST_TOOLCHAIN}-${RUSTUP_TARGET}`,
      ],
      env,
      rustupInstallTimeoutMs,
    );
    return {
      command: join(cargoHome, "bin", "cargo"),
      env,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function resolveCargo(options = {}) {
  const env = options.env ?? process.env;
  const bootstrapImpl = options.bootstrapImpl ?? bootstrapCargo;
  const commandAvailableImpl =
    options.commandAvailableImpl ?? commandAvailable;
  const bootstrapFlag = env.FERRITE_SITES_BOOTSTRAP_RUST;
  if (bootstrapFlag === "1") {
    return await bootstrapImpl({ ...options, env });
  }
  if (bootstrapFlag && bootstrapFlag !== "0") {
    throw new Error("FERRITE_SITES_BOOTSTRAP_RUST must be 0 or 1");
  }
  const command = env.CARGO || "cargo";
  if (await commandAvailableImpl(command, env)) {
    return { command, env, cleanup: async () => {} };
  }
  throw new Error(
    "cargo is unavailable; set FERRITE_SITES_BOOTSTRAP_RUST=1 only in the trusted Sites source build",
  );
}

async function requireDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
}

export async function buildSitesSource(options = {}) {
  const baseEnv = options.env ?? process.env;
  const origin = siteOrigin(options.origin ?? baseEnv.FERRITE_SITE_ORIGIN);
  const resolveCargoImpl = options.resolveCargoImpl ?? resolveCargo;
  const runImpl = options.runImpl ?? run;
  const planImpl = options.buildPlanImpl ?? buildPlan;
  const cargo = await resolveCargoImpl({ env: baseEnv });
  const env = { ...cargo.env, FERRITE_SITE_ORIGIN: origin };
  try {
    for (const step of planImpl(cargo.command)) {
      await runImpl(step.command, step.args, env, step.timeoutMs);
    }
    await requireDirectory(websiteDist, "website dist");
    await rm(outputDist, { recursive: true, force: true });
    await cp(websiteDist, outputDist, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await requireDirectory(outputDist, "root dist");
    return { origin, outputDist };
  } finally {
    await cargo.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSitesSource();
  console.log(`Ferrite Sites source built at ${result.outputDist}`);
}
