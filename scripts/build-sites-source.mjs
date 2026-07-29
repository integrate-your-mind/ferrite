import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const DEFAULT_SITE_ORIGIN = "https://ferrite.mondello.dev";
export const RUST_TOOLCHAIN = "1.95.0";
export const RUSTUP_INIT_URL =
  "https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init";
export const RUSTUP_INIT_SHA256 =
  "20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c";
export const RUSTUP_TARGET = "x86_64-unknown-linux-gnu";
export const ZIG_VERSION = "0.15.2";
export const ZIG_ARCHIVE_URL =
  "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz";
export const ZIG_ARCHIVE_SHA256 =
  "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239";
export const SYSTEM_TAR = "/usr/bin/tar";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = join(root, "node_modules", "typescript", "bin", "tsc");
const website = join(root, "website");
const websiteDist = join(website, "dist");
const outputDist = join(root, "dist");
export const SITE_OUTPUT_ENTRIES = Object.freeze([
  ".openai",
  "client",
  "server",
]);
export const SITE_OUTPUT_LOCK = ".site-build-lock";
const rustupMaximumBytes = 32 * 1024 * 1024;
const rustupInstallTimeoutMs = 5 * 60_000;
const zigMaximumBytes = 60 * 1024 * 1024;
const zigTarMaximumBytes = 1024 * 1024 * 1024;
const zigDownloadTimeoutMs = 2 * 60_000;
const zigExtractTimeoutMs = 2 * 60_000;

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

export function buildPlan(cargo = "cargo", options = {}) {
  const artifactDirectory =
    options.artifactDirectory ?? join(website, ".ferrite", "build");
  const distDirectory = options.distDirectory ?? websiteDist;
  const typesOutput =
    options.typesOutput ??
    join(website, ".ferrite", "types", "routes.d.ts");
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
        "--out",
        artifactDirectory,
        "--types-out",
        typesOutput,
        "--page-renderer",
        join(root, "packages", "runtime", "bin", "render-page.mjs"),
        "--client-bundler",
        join(root, "packages", "runtime", "bin", "build-client.mjs"),
      ],
      timeoutMs: 15 * 60_000,
    },
    {
      command: process.execPath,
      args: [
        join(website, "deploy-adapter.mjs"),
        artifactDirectory,
        distDirectory,
      ],
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

export async function writeVerifiedBody(
  response,
  destination,
  expectedSha256,
  maximumBytes,
) {
  if (!response.body) throw new Error("pinned download response has no body");
  const hash = createHash("sha256");
  let total = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maximumBytes) {
        callback(new Error("pinned download exceeds the size limit"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verifier,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (total === 0) throw new Error("pinned download has an invalid size");
  if (hash.digest("hex") !== expectedSha256) {
    throw new Error("pinned download checksum mismatch");
  }
  return total;
}

export async function decompressXzArchive(
  source,
  destination,
  maximumBytes = zigTarMaximumBytes,
) {
  const XzReadableStream = resolveXzReadableStream(
    await import("xz-decompress"),
  );
  const decoded = new XzReadableStream(
    Readable.toWeb(createReadStream(source)),
  );
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maximumBytes) {
        callback(new Error("pinned Zig archive exceeds the expanded size limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(decoded),
    limiter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (total === 0) {
    throw new Error("pinned Zig archive has an invalid expanded size");
  }
  return total;
}

export function resolveXzReadableStream(module) {
  if (typeof module?.XzReadableStream === "function") {
    return module.XzReadableStream;
  }
  if (typeof module?.default?.XzReadableStream === "function") {
    return module.default.XzReadableStream;
  }
  throw new Error(
    "xz-decompress does not expose the expected XzReadableStream constructor",
  );
}

export async function installZigLinker(options) {
  const toolRoot = options.toolRoot;
  const env = options.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const lstatImpl = options.lstatImpl ?? lstat;
  const runImpl = options.runImpl ?? run;
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const downloadImpl = options.downloadImpl ?? writeVerifiedBody;
  const decompressImpl =
    options.decompressImpl ?? decompressXzArchive;
  const zigUrl = options.zigUrl ?? ZIG_ARCHIVE_URL;
  const expectedSha256 =
    options.expectedSha256 ?? ZIG_ARCHIVE_SHA256;
  const maximumBytes = options.maximumBytes ?? zigMaximumBytes;
  const tarCommand = options.tarCommand ?? SYSTEM_TAR;
  const archive = join(toolRoot, `zig-${ZIG_VERSION}.tar.xz`);
  const tarArchive = join(toolRoot, `zig-${ZIG_VERSION}.tar`);
  const zigRoot = join(toolRoot, "zig");
  const zigBinary = join(zigRoot, "zig");
  const linker = join(toolRoot, "zig-cc.mjs");

  const response = await fetchImpl(zigUrl, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(zigDownloadTimeoutMs),
  });
  if (!response.ok || response.url !== zigUrl) {
    throw new Error(
      `pinned Zig download failed with HTTP ${response.status}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    contentLength > maximumBytes
  ) {
    throw new Error("pinned Zig download exceeds the size limit");
  }
  await downloadImpl(response, archive, expectedSha256, maximumBytes);
  await decompressImpl(archive, tarArchive, zigTarMaximumBytes);
  await mkdirImpl(zigRoot, { recursive: true });
  const tarEnv = { ...env };
  for (const key of ["TAR_OPTIONS", "XZ_DEFAULTS", "XZ_OPT"]) {
    delete tarEnv[key];
  }
  await runImpl(
    tarCommand,
    [
      "-xf",
      tarArchive,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      zigRoot,
    ],
    tarEnv,
    zigExtractTimeoutMs,
  );
  const info = await lstatImpl(zigBinary);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("pinned Zig executable must be a non-symlink file");
  }
  const wrapper = `#!${process.execPath}
import { spawnSync } from "node:child_process";
const result = spawnSync(${JSON.stringify(zigBinary)}, ["cc", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
  await writeFileImpl(linker, wrapper, { mode: 0o700 });
  return linker;
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
  const installLinkerImpl =
    options.installLinkerImpl ?? installZigLinker;
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
    const linker = await installLinkerImpl({
      toolRoot,
      env,
      fetchImpl,
      mkdirImpl,
      runImpl,
      writeFileImpl,
    });
    env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER = linker;
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

async function pathExists(path, lstatImpl = lstat) {
  try {
    await lstatImpl(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function siteOutputIdentity(path, options = {}) {
  const lstatImpl = options.lstatImpl ?? lstat;
  const readFileImpl = options.readFileImpl ?? readFile;
  const readdirImpl = options.readdirImpl ?? readdir;
  const realpathImpl = options.realpathImpl ?? realpath;
  const canonicalRoot = await realpathImpl(path);
  const records = [];

  async function visit(parts) {
    const absolute = join(path, ...parts);
    const info = await lstatImpl(absolute);
    if (info.isSymbolicLink()) {
      throw new Error("website dist snapshot must not contain symlinks");
    }
    const expected = join(canonicalRoot, ...parts);
    if ((await realpathImpl(absolute)) !== expected) {
      throw new Error("website dist snapshot escaped its canonical root");
    }
    if (info.isDirectory()) {
      records.push(["directory", parts]);
      const entries = await readdirImpl(absolute, { withFileTypes: true });
      entries.sort(({ name: left }, { name: right }) =>
        left.localeCompare(right),
      );
      for (const entry of entries) {
        if (
          entry.isSymbolicLink() ||
          (!entry.isDirectory() && !entry.isFile())
        ) {
          throw new Error(
            "website dist snapshot must contain only directories and regular files",
          );
        }
        await visit([...parts, entry.name]);
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(
        "website dist snapshot must contain only directories and regular files",
      );
    }
    const bytes = await readFileImpl(absolute);
    const after = await lstatImpl(absolute);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.size !== bytes.byteLength ||
      (await realpathImpl(absolute)) !== expected
    ) {
      throw new Error("website dist changed during site output snapshot");
    }
    records.push(["file", parts, bytes.byteLength, sha256(bytes)]);
  }

  await visit([]);
  return sha256(Buffer.from(JSON.stringify(records)));
}

async function ensureDestinationDirectory(
  path,
  { lstatImpl = lstat, mkdirImpl = mkdir, realpathImpl = realpath } = {},
) {
  let info;
  try {
    info = await lstatImpl(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdirImpl(path, { recursive: true });
    info = await lstatImpl(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      "site output destination must be a non-symlink directory",
    );
  }
  return await realpathImpl(path);
}

export async function replaceSiteOutput(
  sourceDist,
  destinationDist,
  options = {},
) {
  const cpImpl = options.cpImpl ?? cp;
  const lstatImpl = options.lstatImpl ?? lstat;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const readFileImpl = options.readFileImpl ?? readFile;
  const readdirImpl = options.readdirImpl ?? readdir;
  const realpathImpl = options.realpathImpl ?? realpath;
  const renameImpl = options.renameImpl ?? rename;
  const rmImpl = options.rmImpl ?? rm;

  const sourceInfo = await lstatImpl(sourceDist);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("website dist must be a non-symlink directory");
  }
  const sourceEntries = await readdirImpl(sourceDist, { withFileTypes: true });
  const sourceNames = sourceEntries.map(({ name }) => name).sort();
  const expectedNames = [...SITE_OUTPUT_ENTRIES].sort();
  if (
    sourceNames.length !== expectedNames.length ||
    sourceNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `website dist must contain only ${SITE_OUTPUT_ENTRIES.join(", ")}`,
    );
  }
  for (const entry of sourceEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `website dist entry ${entry.name} must be a non-symlink directory`,
      );
    }
  }
  const identityOptions = {
    lstatImpl,
    readFileImpl,
    readdirImpl,
    realpathImpl,
  };
  const sourceIdentity = await siteOutputIdentity(
    sourceDist,
    identityOptions,
  );

  const destinationRoot = await ensureDestinationDirectory(destinationDist, {
    lstatImpl,
    mkdirImpl,
    realpathImpl,
  });
  const lockPath = join(destinationRoot, SITE_OUTPUT_LOCK);
  try {
    await mkdirImpl(lockPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `site output transaction lock exists at ${lockPath}; preserve and reconcile it before retrying`,
        { cause: error },
      );
    }
    throw error;
  }

  let stagingRoot;
  let backupRoot;
  const installed = [];
  const backedUp = [];
  let operationError;
  const lifecycleErrors = [];
  let preserveLock = false;
  try {
    stagingRoot = await mkdtempImpl(join(destinationRoot, ".site-next-"));
    backupRoot = await mkdtempImpl(
      join(destinationRoot, ".site-backup-"),
    );
    for (const name of SITE_OUTPUT_ENTRIES) {
      await cpImpl(join(sourceDist, name), join(stagingRoot, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    const sourceIdentityAfter = await siteOutputIdentity(
      sourceDist,
      identityOptions,
    );
    const stagingIdentity = await siteOutputIdentity(
      stagingRoot,
      identityOptions,
    );
    if (
      sourceIdentityAfter !== sourceIdentity ||
      stagingIdentity !== sourceIdentity
    ) {
      throw new Error("website dist changed during site output snapshot");
    }
    for (const name of SITE_OUTPUT_ENTRIES) {
      const destination = join(destinationRoot, name);
      if (await pathExists(destination, lstatImpl)) {
        await renameImpl(destination, join(backupRoot, name));
        backedUp.push(name);
      }
      await renameImpl(join(stagingRoot, name), destination);
      installed.push(name);
    }
  } catch (error) {
    operationError = error;
    const rollbackErrors = [];
    for (const name of [...installed].reverse()) {
      try {
        await rmImpl(join(destinationRoot, name), {
          recursive: true,
          force: true,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const name of [...backedUp].reverse()) {
      try {
        await renameImpl(
          join(backupRoot, name),
          join(destinationRoot, name),
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      preserveLock = true;
      lifecycleErrors.push(...rollbackErrors);
    }
  }

  if (!preserveLock) {
    for (const scratch of [backupRoot, stagingRoot]) {
      if (!scratch) continue;
      try {
        await rmImpl(scratch, { recursive: true, force: true });
      } catch (cleanupError) {
        preserveLock = true;
        lifecycleErrors.push(cleanupError);
      }
    }
  }

  if (!preserveLock) {
    try {
      await rmImpl(lockPath, { recursive: true, force: true });
    } catch (lockError) {
      preserveLock = true;
      lifecycleErrors.push(lockError);
    }
  }

  if (operationError || lifecycleErrors.length > 0) {
    if (lifecycleErrors.length === 0) throw operationError;
    throw new AggregateError(
      [...(operationError ? [operationError] : []), ...lifecycleErrors],
      preserveLock
        ? `site output transaction did not cleanly finish; preserve ${lockPath} and any remaining scratch`
        : "site output transaction failed",
    );
  }
}

export async function buildSitesSource(options = {}) {
  const baseEnv = options.env ?? process.env;
  const origin = siteOrigin(options.origin ?? baseEnv.FERRITE_SITE_ORIGIN);
  const resolveCargoImpl = options.resolveCargoImpl ?? resolveCargo;
  const runImpl = options.runImpl ?? run;
  const planImpl = options.buildPlanImpl ?? buildPlan;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const rmImpl = options.rmImpl ?? rm;
  const requireDirectoryImpl =
    options.requireDirectoryImpl ?? requireDirectory;
  const replaceSiteOutputImpl =
    options.replaceSiteOutputImpl ?? replaceSiteOutput;
  const scratchParent = options.scratchParent ?? join(root, ".ferrite");
  const destination = options.outputDist ?? outputDist;
  const cargo = await resolveCargoImpl({ env: baseEnv });
  const env = { ...cargo.env, FERRITE_SITE_ORIGIN: origin };
  let invocationRoot;
  let result;
  let operationError;
  try {
    await mkdirImpl(scratchParent, { recursive: true });
    invocationRoot = await mkdtempImpl(
      join(scratchParent, "sites-source-"),
    );
    const artifactDirectory = join(invocationRoot, "artifact");
    const sourceDist = join(invocationRoot, "dist");
    const typesOutput = join(invocationRoot, "types", "routes.d.ts");
    for (const step of planImpl(cargo.command, {
      artifactDirectory,
      distDirectory: sourceDist,
      typesOutput,
    })) {
      await runImpl(step.command, step.args, env, step.timeoutMs);
    }
    await requireDirectoryImpl(sourceDist, "website dist");
    await replaceSiteOutputImpl(sourceDist, destination);
    await requireDirectoryImpl(destination, "root dist");
    result = { origin, outputDist: destination };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (invocationRoot) {
    try {
      await rmImpl(invocationRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await cargo.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError) {
    if (cleanupErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `${operationError.message}; Sites source build cleanup failed`,
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "Sites source build cleanup failed",
    );
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSitesSource();
  console.log(`Ferrite Sites source built at ${result.outputDist}`);
}
