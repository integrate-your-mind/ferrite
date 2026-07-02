import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

import { nativePrebuildPackageName } from "../binding.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = process.argv[2] ? resolve(process.argv[2]) : join(packageRoot, "dist", "prebuild");
const bindingSource = join(packageRoot, "dist", "ferrite-node.node");
const packageName = nativePrebuildPackageName();

if (!packageName) {
  throw new Error(`No Ferrite native prebuild package mapping exists for ${platform}/${arch}.`);
}

await stat(bindingSource).catch((error) => {
  throw new Error(
    `Ferrite native binding was not found at ${bindingSource}. Run \`pnpm --filter @ferrite/node build\` first. ${error.message}`,
  );
});

const nodePackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const manifest = {
  name: packageName,
  version: nodePackage.version,
  os: [platform],
  cpu: [arch],
  files: ["ferrite-node.node"],
  exports: {
    "./ferrite-node.node": "./ferrite-node.node",
  },
};

await mkdir(destinationRoot, { recursive: true });
await copyFile(bindingSource, join(destinationRoot, "ferrite-node.node"));
await writeFile(join(destinationRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Ferrite native prebuild package ${packageName} written to ${destinationRoot}`);
