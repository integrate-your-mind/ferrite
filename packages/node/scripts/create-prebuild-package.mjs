import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

import { nativePrebuildPackageName } from "../binding.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = process.argv[2] ? resolve(process.argv[2]) : join(packageRoot, "dist", "prebuild");
const bindingSource = join(packageRoot, "dist", "ferrite-node.node");
const checksumFile = "ferrite-node.sha256.json";
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
const bindingBytes = await readFile(bindingSource);
const checksum = createHash("sha256").update(bindingBytes).digest("hex");
const manifest = {
  name: packageName,
  version: nodePackage.version,
  description: `Ferrite native Node.js binding for ${platform}/${arch}.`,
  license: nodePackage.license,
  keywords: nodePackage.keywords,
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

await mkdir(destinationRoot, { recursive: true });
await copyFile(bindingSource, join(destinationRoot, "ferrite-node.node"));
await writeFile(join(destinationRoot, checksumFile), `${JSON.stringify(checksumManifest, null, 2)}\n`);
await writeFile(join(destinationRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Ferrite native prebuild package ${packageName} written to ${destinationRoot}`);
