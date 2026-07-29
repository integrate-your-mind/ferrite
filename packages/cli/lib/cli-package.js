import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync as defaultReadFileSync,
  statSync as defaultStatSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  arch as currentArch,
  env as currentEnv,
  platform as currentPlatform,
} from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checksumFile = "ferrite-cli.sha256.json";
const npmVersionEnvironmentVariable = "FERRITE_INTERNAL_NPM_PACKAGE_VERSION";

export const CLI_CHECKSUM_ALGORITHM = "sha256";
export const SUPPORTED_CLI_TARGETS = Object.freeze([
  Object.freeze({
    platform: "darwin",
    arch: "arm64",
    packageName: "@ferrite/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    binaryFile: "bin/ferrite",
  }),
]);

const targetPackages = new Map(
  SUPPORTED_CLI_TARGETS.map((target) => [
    `${target.platform}:${target.arch}`,
    target,
  ]),
);

export function cliTarget({ platform = currentPlatform, arch = currentArch } = {}) {
  return targetPackages.get(`${platform}:${arch}`) ?? null;
}

export function isExactSemver(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const buildParts = value.split("+");
  if (buildParts.length > 2) return false;
  const [withoutBuild, build] = buildParts;
  if (build !== undefined && !validIdentifiers(build, false)) return false;

  const separator = withoutBuild.indexOf("-");
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
  if (prerelease !== undefined && !validIdentifiers(prerelease, true)) return false;

  const numbers = core.split(".");
  return (
    numbers.length === 3 &&
    numbers.every(
      (number) =>
        /^[0-9]+$/.test(number) &&
        (number === "0" || !number.startsWith("0")),
    )
  );
}

export function ferriteBinaryVersionForPackage(packageVersion) {
  if (!isExactSemver(packageVersion)) {
    throw new Error("Ferrite CLI package version must be exact semantic version.");
  }
  return `ferrite ${packageVersion.split(/[+-]/, 1)[0]}`;
}

export function resolveCliBinary({
  platform = currentPlatform,
  arch = currentArch,
  packageRoot: root = packageRoot,
  requireFunction = require,
  readFileSync = defaultReadFileSync,
  statSync = defaultStatSync,
} = {}) {
  const target = cliTarget({ platform, arch });
  if (!target) {
    throw new Error(
      `Ferrite CLI has no verified npm binary for ${platform}/${arch}. ` +
        "The current package candidate supports only darwin/arm64.",
    );
  }

  const wrapperManifest = readJsonFile(
    join(root, "package.json"),
    "@ferrite/cli package manifest",
    readFileSync,
  );
  assertPackageVersion(wrapperManifest, "@ferrite/cli package manifest");
  if (
    wrapperManifest.optionalDependencies?.[target.packageName] !==
    wrapperManifest.version
  ) {
    throw new Error(
      `@ferrite/cli must declare exact optional dependency ${target.packageName}@${wrapperManifest.version}.`,
    );
  }

  const paths = resolveTargetFiles(requireFunction, target);
  if (!paths) {
    throw new Error(
      `Ferrite CLI binary package ${target.packageName}@${wrapperManifest.version} is not installed. ` +
        "Optional dependencies may have been omitted or the package may not exist for this host.",
    );
  }

  const platformManifest = readJsonFile(
    paths.packageManifest,
    `${target.packageName} package manifest`,
    readFileSync,
  );
  verifyPlatformManifest(platformManifest, wrapperManifest.version, target);

  const checksumManifest = readJsonFile(
    paths.checksum,
    `${target.packageName} checksum manifest`,
    readFileSync,
  );
  const binaryStat = statSync(paths.binary);
  if (!binaryStat.isFile()) {
    throw new Error(`${target.packageName} binary is not a regular file: ${paths.binary}.`);
  }
  if (platform !== "win32" && (binaryStat.mode & 0o111) === 0) {
    throw new Error(`${target.packageName} binary is not executable: ${paths.binary}.`);
  }

  const binary = readFileSync(paths.binary);
  verifyChecksumManifest(checksumManifest, {
    binary,
    binaryFile: target.binaryFile,
    packageName: target.packageName,
    packageVersion: wrapperManifest.version,
  });

  return {
    path: paths.binary,
    packageName: target.packageName,
    packageVersion: wrapperManifest.version,
  };
}

export function launchFerrite(
  args,
  {
    env = currentEnv,
    resolveBinary = resolveCliBinary,
    spawnSync = defaultSpawnSync,
    ...resolveOptions
  } = {},
) {
  const resolved = resolveBinary(resolveOptions);
  const result = spawnSync(resolved.path, args, {
    env: {
      ...env,
      [npmVersionEnvironmentVariable]: resolved.packageVersion,
    },
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(
      `Ferrite CLI failed to launch ${resolved.path}: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.signal) {
    return { status: null, signal: result.signal };
  }
  if (!Number.isInteger(result.status) || result.status < 0 || result.status > 255) {
    throw new Error(`Ferrite CLI returned an invalid exit status: ${String(result.status)}.`);
  }

  return { status: result.status, signal: null };
}

export function verifyChecksumManifest(
  manifest,
  { binary, binaryFile, packageName, packageVersion },
) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${packageName} ${checksumFile} must be a JSON object.`);
  }
  if (manifest.file !== binaryFile) {
    throw new Error(`${packageName} ${checksumFile} must describe ${binaryFile}.`);
  }
  if (manifest.algorithm !== CLI_CHECKSUM_ALGORITHM) {
    throw new Error(
      `${packageName} ${checksumFile} uses unsupported algorithm ${String(manifest.algorithm)}.`,
    );
  }
  if (manifest.packageVersion !== packageVersion) {
    throw new Error(
      `${packageName} ${checksumFile} package version ${String(manifest.packageVersion)} ` +
        `does not match @ferrite/cli ${packageVersion}.`,
    );
  }
  if (manifest.runtimeVersion !== packageVersion) {
    throw new Error(
      `${packageName} ${checksumFile} runtime version ${String(manifest.runtimeVersion)} ` +
        `does not match @ferrite/cli ${packageVersion}.`,
    );
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1) {
    throw new Error(`${packageName} ${checksumFile} must include a positive byte count.`);
  }
  if (binary.length !== manifest.bytes) {
    throw new Error(
      `${packageName} binary size mismatch: expected ${manifest.bytes}, got ${binary.length}.`,
    );
  }
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error(`${packageName} ${checksumFile} must include a lowercase hex sha256 digest.`);
  }

  const actual = createHash(CLI_CHECKSUM_ALGORITHM).update(binary).digest("hex");
  if (actual !== manifest.sha256) {
    throw new Error(
      `${packageName} checksum mismatch for ${binaryFile}: expected ${manifest.sha256}, got ${actual}.`,
    );
  }

  return actual;
}

function resolveTargetFiles(requireFunction, target) {
  try {
    return {
      binary: requireFunction.resolve(`${target.packageName}/${target.binaryFile}`),
      checksum: requireFunction.resolve(`${target.packageName}/${checksumFile}`),
      packageManifest: requireFunction.resolve(`${target.packageName}/package.json`),
    };
  } catch {
    return null;
  }
}

function readJsonFile(path, label, readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function assertPackageVersion(manifest, label) {
  if (!isExactSemver(manifest.version)) {
    throw new Error(`${label} must include an exact semantic version.`);
  }
}

function verifyPlatformManifest(manifest, version, target) {
  assertPackageVersion(manifest, `${target.packageName} package manifest`);
  if (manifest.name !== target.packageName) {
    throw new Error(
      `Ferrite CLI expected ${target.packageName}, got package ${String(manifest.name)}.`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(
      `${target.packageName} version ${manifest.version} does not match @ferrite/cli ${version}.`,
    );
  }
  if (
    !Array.isArray(manifest.os) ||
    manifest.os.length !== 1 ||
    manifest.os[0] !== target.os ||
    !Array.isArray(manifest.cpu) ||
    manifest.cpu.length !== 1 ||
    manifest.cpu[0] !== target.cpu
  ) {
    throw new Error(
      `${target.packageName} must declare os=${target.os} and cpu=${target.cpu}.`,
    );
  }
}

function validIdentifiers(value, rejectNumericLeadingZero) {
  return (
    value.length > 0 &&
    value.split(".").every(
      (identifier) =>
        identifier.length > 0 &&
        /^[0-9A-Za-z-]+$/.test(identifier) &&
        !(
          rejectNumericLeadingZero &&
          /^[0-9]+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0")
        ),
    )
  );
}
