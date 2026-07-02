import { existsSync as defaultExistsSync } from "node:fs";
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

const PREBUILD_PACKAGES = new Map([
  ["darwin:arm64", "@ferrite/node-darwin-arm64"],
  ["darwin:x64", "@ferrite/node-darwin-x64"],
  ["linux:arm64", "@ferrite/node-linux-arm64-gnu"],
  ["linux:x64", "@ferrite/node-linux-x64-gnu"],
  ["win32:x64", "@ferrite/node-win32-x64-msvc"],
]);

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

function resolvePrebuildBinding(requireFunction, packageName) {
  try {
    return requireFunction.resolve(`${packageName}/ferrite-node.node`);
  } catch {
    return null;
  }
}
