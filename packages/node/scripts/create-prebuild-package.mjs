import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { arch as currentArch, argv, platform as currentPlatform } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nativePrebuildPackageName } from "../binding.js";

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checksumFile = "ferrite-node.sha256.json";

export async function createPrebuildPackage({
  packageRoot = defaultPackageRoot,
  destinationRoot = join(packageRoot, "dist", "prebuild"),
  platform = currentPlatform,
  arch = currentArch,
} = {}) {
  const resolvedPackageRoot = resolve(packageRoot);
  const resolvedDestinationRoot = resolve(destinationRoot);
  const bindingSource = join(resolvedPackageRoot, "dist", "ferrite-node.node");
  const packageName = nativePrebuildPackageName({ platform, arch });

  if (!packageName) {
    throw new Error(`No Ferrite native prebuild package mapping exists for ${platform}/${arch}.`);
  }

  await stat(bindingSource).catch((error) => {
    throw new Error(
      `Ferrite native binding was not found at ${bindingSource}. Run \`pnpm --filter @ferrite/node build\` first. ${error.message}`,
    );
  });

  const nodePackage = JSON.parse(await readFile(join(resolvedPackageRoot, "package.json"), "utf8"));
  const bindingBytes = await readFile(bindingSource);
  const checksum = createHash("sha256").update(bindingBytes).digest("hex");
  const manifest = {
    name: packageName,
    version: nodePackage.version,
    description: `Ferrite native Node.js binding for ${platform}/${arch}.`,
    license: nodePackage.license,
    keywords: nodePackage.keywords,
    repository: nodePackage.repository,
    homepage: nodePackage.homepage,
    bugs: nodePackage.bugs,
    engines: nodePackage.engines,
    publishConfig: {
      access: "public",
    },
    os: [platform],
    cpu: [arch],
    files: ["ferrite-node.node", checksumFile],
    exports: {
      "./ferrite-node.node": "./ferrite-node.node",
      [`./${checksumFile}`]: `./${checksumFile}`,
    },
  };
  const checksumManifest = {
    file: "ferrite-node.node",
    algorithm: "sha256",
    sha256: checksum,
  };

  await mkdir(resolvedDestinationRoot, { recursive: true });
  await copyFile(bindingSource, join(resolvedDestinationRoot, "ferrite-node.node"));
  await writeFile(join(resolvedDestinationRoot, checksumFile), `${JSON.stringify(checksumManifest, null, 2)}\n`);
  await writeFile(join(resolvedDestinationRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    directory: resolvedDestinationRoot,
    packageName,
  };
}

async function main() {
  const destinationRoot = argv[2] ? resolve(argv[2]) : join(defaultPackageRoot, "dist", "prebuild");
  const result = await createPrebuildPackage({ destinationRoot });
  console.log(`Ferrite native prebuild package ${result.packageName} written to ${result.directory}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
