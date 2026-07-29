import { cp, lstat, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SITE_ORIGIN = "https://ferrite.mondello.dev";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const typescript = join(root, "node_modules", "typescript", "bin", "tsc");
const website = join(root, "website");
const websiteDist = join(website, "dist");
const outputDist = join(root, "dist");

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

export function buildPlan() {
  return [
    {
      command: process.execPath,
      args: [typescript, "-p", join(root, "packages", "protocol", "tsconfig.json")],
    },
    {
      command: process.execPath,
      args: [typescript, "-p", join(root, "packages", "runtime", "tsconfig.json")],
    },
    {
      command: "cargo",
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
    },
    {
      command: process.execPath,
      args: [join(website, "deploy-adapter.mjs")],
    },
  ];
}

async function run(command, args, env) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        accept();
        return;
      }
      reject(
        new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`),
      );
    });
  });
}

async function requireDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
}

export async function buildSitesSource(options = {}) {
  const origin = siteOrigin(options.origin ?? process.env.FERRITE_SITE_ORIGIN);
  const env = { ...process.env, FERRITE_SITE_ORIGIN: origin };
  for (const step of buildPlan()) await run(step.command, step.args, env);
  await requireDirectory(websiteDist, "website dist");
  await rm(outputDist, { recursive: true, force: true });
  await cp(websiteDist, outputDist, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await requireDirectory(outputDist, "root dist");
  return { origin, outputDist };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSitesSource();
  console.log(`Ferrite Sites source built at ${result.outputDist}`);
}
