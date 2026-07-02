import { createHash } from "node:crypto";
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  arch as currentArch,
  cwd as currentCwd,
  env as currentEnv,
  platform as currentPlatform,
} from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = dirname(fileURLToPath(import.meta.url));
const PREBUILD_CHECKSUM_FILE = "ferrite-node.sha256.json";
export const NATIVE_CHECKSUM_ALGORITHM = "sha256";

export const SUPPORTED_NATIVE_PREBUILD_TARGETS = Object.freeze([
  Object.freeze({
    platform: "darwin",
    arch: "arm64",
    packageName: "@ferrite/node-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  }),
  Object.freeze({
    platform: "darwin",
    arch: "x64",
    packageName: "@ferrite/node-darwin-x64",
    os: "darwin",
    cpu: "x64",
  }),
  Object.freeze({
    platform: "linux",
    arch: "arm64",
    packageName: "@ferrite/node-linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
  }),
  Object.freeze({
    platform: "linux",
    arch: "x64",
    packageName: "@ferrite/node-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
  }),
  Object.freeze({
    platform: "win32",
    arch: "x64",
    packageName: "@ferrite/node-win32-x64-msvc",
    os: "win32",
    cpu: "x64",
  }),
]);

const PREBUILD_PACKAGES = new Map(
  SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => [
    `${target.platform}:${target.arch}`,
    target.packageName,
  ]),
);

export function nativePrebuildPackageName({ platform = currentPlatform, arch = currentArch } = {}) {
  return PREBUILD_PACKAGES.get(`${platform}:${arch}`) ?? null;
}

export function nativeBindingCandidates({
  env = currentEnv,
  packageRoot: root = packageRoot,
  platform = currentPlatform,
  arch = currentArch,
  requireFunction = require,
  cwd = currentCwd(),
} = {}) {
  if (env.FERRITE_NODE_BINDING) {
    return [
      {
        kind: "env",
        path: resolve(cwd, env.FERRITE_NODE_BINDING),
        required: true,
      },
    ];
  }

  const candidates = [
    {
      kind: "local",
      path: join(root, "dist", "ferrite-node.node"),
      required: false,
    },
  ];
  const packageName = nativePrebuildPackageName({ platform, arch });
  if (packageName) {
    candidates.push({
      kind: "prebuild",
      packageName,
      path: resolvePrebuildBinding(requireFunction, packageName),
      checksumPath: resolvePrebuildFile(requireFunction, packageName, PREBUILD_CHECKSUM_FILE),
      required: false,
    });
  }

  return candidates;
}

export function resolveNativeBindingPath(options = {}) {
  const existsSync = options.existsSync ?? defaultExistsSync;
  const candidates = nativeBindingCandidates(options);

  for (const candidate of candidates) {
    if (candidate.path && existsSync(candidate.path)) {
      verifyNativeBindingCandidate(candidate, options);
      return candidate.path;
    }
  }

  if (candidates.length === 1 && candidates[0].kind === "env") {
    throw new Error(
      `Ferrite native binding was not found at ${candidates[0].path} from FERRITE_NODE_BINDING.`,
    );
  }

  const platform = options.platform ?? currentPlatform;
  const arch = options.arch ?? currentArch;
  const checked = candidates
    .map((candidate) => {
      if (candidate.kind === "prebuild" && !candidate.path) {
        return `${candidate.packageName}/ferrite-node.node (package not installed)`;
      }
      return candidate.path;
    })
    .join(", ");
  const supported = nativePrebuildPackageName({ platform, arch })
    ? ""
    : ` No optional prebuild package is defined for ${platform}/${arch}.`;

  throw new Error(
    `Ferrite native binding was not found. Checked: ${checked}. Run \`pnpm --filter @ferrite/node build\` for a source build or install the matching optional native package.${supported}`,
  );
}

export function verifyNativePrebuildChecksum({
  bindingPath,
  checksumPath,
  packageName = "Ferrite native prebuild",
  readFileSync = defaultReadFileSync,
} = {}) {
  if (!bindingPath) {
    throw new Error(`${packageName} checksum verification requires a native binding path.`);
  }
  if (!checksumPath) {
    throw new Error(`${packageName} must include ${PREBUILD_CHECKSUM_FILE}.`);
  }

  const manifest = parseChecksumManifest(readFileSync(checksumPath, "utf8"), packageName);
  const actual = createHash(NATIVE_CHECKSUM_ALGORITHM).update(readFileSync(bindingPath)).digest("hex");
  if (actual !== manifest.sha256) {
    throw new Error(
      `${packageName} checksum mismatch for ferrite-node.node: expected ${manifest.sha256}, got ${actual}.`,
    );
  }

  return actual;
}

function resolvePrebuildBinding(requireFunction, packageName) {
  return resolvePrebuildFile(requireFunction, packageName, "ferrite-node.node");
}

function resolvePrebuildFile(requireFunction, packageName, fileName) {
  try {
    return requireFunction.resolve(`${packageName}/${fileName}`);
  } catch {
    return null;
  }
}

function verifyNativeBindingCandidate(candidate, options) {
  if (candidate.kind !== "prebuild") {
    return;
  }

  verifyNativePrebuildChecksum({
    bindingPath: candidate.path,
    checksumPath: candidate.checksumPath,
    packageName: candidate.packageName,
    readFileSync: options.readFileSync ?? defaultReadFileSync,
  });
}

function parseChecksumManifest(source, packageName) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${packageName} has an invalid ${PREBUILD_CHECKSUM_FILE}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${packageName} ${PREBUILD_CHECKSUM_FILE} must be a JSON object.`);
  }
  if (manifest.file !== "ferrite-node.node") {
    throw new Error(`${packageName} ${PREBUILD_CHECKSUM_FILE} must describe ferrite-node.node.`);
  }
  if (manifest.algorithm !== NATIVE_CHECKSUM_ALGORITHM) {
    throw new Error(
      `${packageName} ${PREBUILD_CHECKSUM_FILE} uses unsupported algorithm ${String(manifest.algorithm)}.`,
    );
  }
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error(`${packageName} ${PREBUILD_CHECKSUM_FILE} must include a hex sha256 digest.`);
  }

  return manifest;
}
