import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { argv, exit, platform } from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_PACKAGES = ["@ferrite/protocol", "@ferrite/runtime"];

export function parseStarterArgs(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 1 || !values[0]) {
    throw new Error("usage: pnpm starter:create -- <target>");
  }
  return values[0];
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function readTargetState(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`refusing symbolic-link starter target: ${target}`);
    if (!info.isDirectory()) throw new Error(`starter target is not a directory: ${target}`);
    if ((await readdir(target)).length > 0) throw new Error(`refusing to initialize non-empty directory: ${target}`);
    return { exists: true, device: info.dev, inode: info.ino };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { exists: false };
  }
}

async function inspectTarget(target) {
  const requestedPath = resolve(target);
  const targetName = basename(requestedPath);
  if (!targetName) throw new Error(`starter target must name a directory below an existing parent: ${target}`);
  const parent = await realpath(dirname(requestedPath)).catch((error) => {
    throw new Error(`starter target parent must already exist: ${dirname(requestedPath)} (${error.message})`);
  });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error(`starter target parent is not a directory: ${parent}`);
  const targetPath = join(parent, targetName);
  const state = await readTargetState(targetPath);
  if (state.exists) throw new Error(`refusing to initialize existing directory; choose an absent target: ${targetPath}`);
  return { path: targetPath };
}

export async function validateSourceStarterTarget(target) {
  return (await inspectTarget(target)).path;
}

function validatePackages(packages) {
  const byName = new Map((packages ?? []).map((pkg) => [pkg?.name, pkg]));
  for (const name of REQUIRED_PACKAGES) {
    const descriptor = byName.get(name);
    if (!descriptor?.tarballPath) throw new Error(`missing required tarball descriptor for ${name}`);
  }
  return byName;
}

async function rewriteManifest(target, packages) {
  const packagePath = join(target, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  for (const field of dependencyFields) {
    for (const name of REQUIRED_PACKAGES) {
      if (field !== "dependencies" && manifest[field]?.[name]) delete manifest[field][name];
    }
  }
  manifest.dependencies ??= {};
  for (const name of REQUIRED_PACKAGES) {
    const tarballName = basename(packages.get(name).tarballPath);
    const tarballPath = relative(target, join(target, ".ferrite-source", "packages", tarballName)).replaceAll("\\", "/");
    manifest.dependencies[name] = `file:${tarballPath}`;
  }
  if (manifest.scripts) {
    for (const [name, value] of Object.entries(manifest.scripts)) {
      if (typeof value === "string" && /(^|\s)ferrite(?:\.exe)?(?:\s|$)/.test(value)) {
        manifest.scripts[name] = value.replace(/(^|\s)ferrite(?:\.exe)?(?=\s|$)/g, "$1node .ferrite-source/run-ferrite.mjs");
      }
    }
  }
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function createSourceStarter({ target, packages, cliSource, runCommand = run }) {
  if (!target || !cliSource) throw new Error("target and cliSource are required");
  const cliPath = resolve(cliSource);
  const packageMap = validatePackages(packages);
  const cliInfo = await stat(cliPath);
  if (!cliInfo.isFile()) throw new Error(`source-built CLI is not a file: ${cliPath}`);
  for (const descriptor of packageMap.values()) {
    const tarballInfo = await stat(resolve(descriptor.tarballPath));
    if (!tarballInfo.isFile()) throw new Error(`package tarball is not a file: ${descriptor.tarballPath}`);
  }
  const targetDescriptor = await inspectTarget(target);
  const targetPath = targetDescriptor.path;
  const stagingPath = await mkdtemp(join(dirname(targetPath), `.${basename(targetPath)}.ferrite-starter-`));
  await chmod(stagingPath, 0o700);
  const stagingInfo = await lstat(stagingPath);
  try {
    await runCommand(cliPath, ["init", stagingPath], { cwd: dirname(cliPath) });
    const sourceDir = join(stagingPath, ".ferrite-source");
    const packageDir = join(sourceDir, "packages");
    const binDir = join(sourceDir, "bin");
    await mkdir(packageDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    for (const name of REQUIRED_PACKAGES) {
      await cp(resolve(packageMap.get(name).tarballPath), join(packageDir, basename(packageMap.get(name).tarballPath)));
    }
    const cliName = platform === "win32" ? "ferrite.exe" : "ferrite";
    const copiedCli = join(binDir, cliName);
    await cp(cliPath, copiedCli);
    const cliMode = (await stat(cliPath)).mode;
    await chmod(copiedCli, cliMode & 0o777);
    await writeFile(
      join(sourceDir, "run-ferrite.mjs"),
      `import { spawnSync } from "node:child_process";\nimport { join } from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst bin = process.platform === "win32" ? "ferrite.exe" : "ferrite";\nconst result = spawnSync(join(fileURLToPath(new URL(".", import.meta.url)), "bin", bin), process.argv.slice(2), { stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`,
    );
    await rewriteManifest(stagingPath, packageMap);
    const gitignorePath = join(stagingPath, ".gitignore");
    const gitignore = await readFile(gitignorePath, "utf8").catch(() => "");
    if (!gitignore.split(/\r?\n/).includes(".ferrite-source/")) {
      await writeFile(gitignorePath, `${gitignore}${gitignore.endsWith("\n") || !gitignore ? "" : "\n"}.ferrite-source/\n`);
    }
    await runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--fund=false"], { cwd: stagingPath });
    await runCommand("npm", ["run", "check"], { cwd: stagingPath });
    await publishStagedStarter({ stagingPath, targetPath, cliPath, runCommand });
    return { target: targetPath, sourceDir: join(targetPath, ".ferrite-source") };
  } catch (error) {
    try {
      await cleanupOwnedStaging(stagingPath, stagingInfo);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "source starter failed and cleanup was incomplete");
    }
    throw error;
  }
}

async function publishStagedStarter({ stagingPath, targetPath, cliPath, runCommand }) {
  const currentState = await readTargetState(targetPath);
  if (currentState.exists) {
    throw new Error(`starter target appeared during creation: ${targetPath}`);
  }
  await runCommand(cliPath, ["internal-publish-dir", stagingPath, targetPath], { cwd: dirname(cliPath) });
}

async function cleanupOwnedStaging(stagingPath, expectedInfo) {
  let currentInfo;
  try {
    currentInfo = await lstat(stagingPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    currentInfo.isSymbolicLink() ||
    !currentInfo.isDirectory() ||
    currentInfo.dev !== expectedInfo.dev ||
    currentInfo.ino !== expectedInfo.ino
  ) {
    throw new Error(`refusing to clean replaced starter staging directory: ${stagingPath}`);
  }
  await rm(stagingPath, { recursive: true, force: false });
}

async function main() {
  const target = parseStarterArgs(argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const targetPath = await validateSourceStarterTarget(target);
  const { verifyNpmPackages } = await import("./verify-npm-packages.mjs");
  let starter;
  await verifyNpmPackages({
    publishManifestMode: true,
    repositoryUrl: "https://github.com/integrate-your-mind/ferrite",
    writeReports: false,
    installPackageSet: async (packages) => {
      starter = await createSourceStarter({
        target: targetPath,
        packages,
        cliSource: join(root, "target", "debug", platform === "win32" ? "ferrite.exe" : "ferrite"),
      });
    },
  });
  if (!starter) throw new Error("source starter package preparation did not run");
  console.log(`Starter created at ${resolve(target)}`);
  console.log(`Next: cd ${JSON.stringify(resolve(target))}`);
  console.log("Next: npm run dev");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
