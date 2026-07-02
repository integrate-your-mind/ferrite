# npm Publishing Prep Implementation Plan

Status note, July 2, 2026: this plan records the original milestone 061 dry-run implementation. Milestone 063 superseded the npm verifier behavior by staging release-shaped package copies, running real `npm pack --json`, inspecting packed `package/package.json`, and recording both release and packed manifests. Milestone 064 added clean offline install smoke for the generated tarballs. Dry-run snippets below are historical plan details, not the current verifier contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Ferrite's JavaScript-facing packages for npm publication dry-runs without publishing packages or inventing unavailable GitHub/npm remote state.

**Architecture:** Keep source packages private while adding release metadata that is knowable locally. The current verifier builds packages, stages release-shaped package copies, runs real `npm pack --json`, checks packed file lists, validates packed manifests from the tarball, clean-installs the generated tarballs together offline, and fails closed for missing remote-only metadata when publish mode is requested. The read-only GitHub Actions workflow remains non-publishing and remote proof remains unavailable in this checkout.

**Tech Stack:** Node.js ESM scripts and `node:test`, pnpm workspace package scripts, npm CLI pack dry-runs, GitHub Actions, Rust/Cargo build gates, TypeScript package builds.

---

## File Structure

- Create `scripts/verify-npm-packages.mjs`: build source packages, inspect package manifests, stage release-shaped package copies, run `npm pack --json`, validate packed files and packed manifest invariants, and write JSON reports under `dist/npm-packages`.
- Create `scripts/verify-npm-packages.test.mjs`: unit tests for manifest rewriting, workspace dependency rejection, required metadata checks, pack-output file checks, and remote-metadata publish-mode failures.
- Modify `package.json`: add `release:verify:npm` and include the verifier test in the root `test` script.
- Modify `packages/protocol/package.json`: add local release metadata that is knowable without a remote.
- Modify `packages/protocol-wasm/package.json`: add local release metadata and keep workspace dependency for development.
- Modify `packages/runtime/package.json`: add local release metadata and keep workspace dependency for development.
- Modify `packages/node/package.json`: add local release metadata and exclude the local source-build artifact from the published main package file list.
- Modify `packages/node/scripts/create-prebuild-package.mjs`: include public package metadata in generated native package manifests.
- Modify `packages/node/scripts/verify-prebuild-package.mjs`: verify native package release metadata.
- Create `.github/workflows/npm-publish-dry-run.yml`: run the verifier without registry credentials or `id-token: write`.
- Create `docs/milestone-061-plan.md`: concise milestone plan.
- Create `docs/milestone-061-proof.md`: local proof notes and remote/npm gaps.
- Modify `README.md`: add release dry-run commands and current npm publication boundary.
- Modify `docs/architecture.md`: describe npm publish-prep boundary and remaining real-publish requirements.

## Remote Metadata Policy

The current checkout has no configured Git remote and no confirmed npm publisher state. Do not add fake `repository`, `homepage`, or `bugs` URLs to source manifests.

The verifier has two modes:

- Default local mode: proves source package metadata, staged package file lists, workspace dependency rewriting in packed tarball manifests, native optional dependency expectations in those packed manifests, `npm pack --json` output, and clean offline install of the generated local tarballs without requiring a remote URL.
- Publish-manifest mode: enabled by `--publish-manifest --repository-url <https-url>`. This mode validates that release-shaped manifests contain `repository`, `homepage`, `bugs`, no `private: true`, no `workspace:*`, public access, and native optional dependencies. It fails if the URL is missing.

The read-only workflow uses default local mode because the repository URL is not configured in this checkout. The proof document must list publish-manifest mode, real npm publication, trusted publishing, registry credentials, and remote CI execution as not proven until those states exist.

## Task 1: Add Release Verifier Tests

**Files:**
- Create: `scripts/verify-npm-packages.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Create failing verifier tests**

Create `scripts/verify-npm-packages.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_PACKAGE_NAMES,
  createReleaseManifest,
  validateManifestMetadata,
  validatePackFiles,
} from "./verify-npm-packages.mjs";

test("release package set stays explicit", () => {
  assert.deepEqual(RELEASE_PACKAGE_NAMES, [
    "@ferrite/protocol",
    "@ferrite/protocol-wasm",
    "@ferrite/runtime",
    "@ferrite/node",
  ]);
});

test("release manifest removes private and rewrites workspace dependencies", () => {
  const manifest = createReleaseManifest(
    {
      name: "@ferrite/runtime",
      version: "0.1.0",
      private: true,
      dependencies: {
        "@ferrite/protocol": "workspace:*",
      },
    },
    {
      packageVersions: new Map([
        ["@ferrite/protocol", "0.1.0"],
        ["@ferrite/runtime", "0.1.0"],
      ]),
      nativePackageNames: [],
    },
  );

  assert.equal(Object.hasOwn(manifest, "private"), false);
  assert.deepEqual(manifest.dependencies, {
    "@ferrite/protocol": "0.1.0",
  });
});

test("release manifest adds expected native optional dependencies for @ferrite/node", () => {
  const manifest = createReleaseManifest(
    {
      name: "@ferrite/node",
      version: "0.1.0",
      private: true,
    },
    {
      packageVersions: new Map([["@ferrite/node", "0.1.0"]]),
      nativePackageNames: [
        "@ferrite/node-darwin-arm64",
        "@ferrite/node-linux-x64-gnu",
      ],
    },
  );

  assert.deepEqual(manifest.optionalDependencies, {
    "@ferrite/node-darwin-arm64": "0.1.0",
    "@ferrite/node-linux-x64-gnu": "0.1.0",
  });
});

test("metadata validation reports missing local metadata", () => {
  assert.throws(
    () =>
      validateManifestMetadata({
        packageName: "@ferrite/protocol",
        sourceManifest: {
          name: "@ferrite/protocol",
          version: "0.1.0",
          private: true,
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
        releaseManifest: {
          name: "@ferrite/protocol",
          version: "0.1.0",
          files: ["dist"],
          exports: { ".": "./dist/index.js" },
          publishConfig: { access: "public" },
        },
      }),
    /@ferrite\/protocol: package description is required/,
  );
});

test("publish-manifest mode requires remote metadata", () => {
  assert.throws(
    () =>
      validateManifestMetadata({
        packageName: "@ferrite/protocol",
        sourceManifest: completeSourceManifest("@ferrite/protocol"),
        releaseManifest: completeReleaseManifest("@ferrite/protocol"),
        publishManifestMode: true,
      }),
    /@ferrite\/protocol: publish-manifest mode requires repository metadata/,
  );
});

test("pack file validation accepts required files and rejects forbidden files", () => {
  validatePackFiles({
    packageName: "@ferrite/node",
    files: ["package/binding.js", "package/index.js", "package/index.d.ts"],
    requiredFiles: ["binding.js", "index.js", "index.d.ts"],
    forbiddenFiles: ["dist/ferrite-node.node"],
  });

  assert.throws(
    () =>
      validatePackFiles({
        packageName: "@ferrite/node",
        files: ["package/binding.js", "package/index.js", "package/index.d.ts", "package/dist/ferrite-node.node"],
        requiredFiles: ["binding.js", "index.js", "index.d.ts"],
        forbiddenFiles: ["dist/ferrite-node.node"],
      }),
    /@ferrite\/node: packed package must not include dist\/ferrite-node.node/,
  );
});

test("default verifier mode can write a local report directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ferrite-npm-report-"));
  try {
    await mkdir(join(root, "dist", "npm-packages"), { recursive: true });
    await writeFile(join(root, "dist", "npm-packages", "report.json"), "{}\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

function completeSourceManifest(name) {
  return {
    name,
    version: "0.1.0",
    private: true,
    description: "Ferrite test package.",
    license: "UNLICENSED",
    keywords: ["ferrite"],
    files: ["dist"],
    exports: { ".": "./dist/index.js" },
    publishConfig: { access: "public" },
  };
}

function completeReleaseManifest(name) {
  const manifest = completeSourceManifest(name);
  delete manifest.private;
  return manifest;
}
```

- [x] **Step 2: Add the root release verifier test script**

In `package.json`, add a script entry:

```json
"test:release": "node --test scripts/*.test.mjs"
```

Change the root `test` script to run verifier tests before package tests:

```json
"test": "node --test scripts/*.test.mjs && cargo test --workspace && pnpm --filter @ferrite/protocol test && pnpm --filter @ferrite/protocol-wasm test && pnpm --filter @ferrite/runtime test && pnpm --filter @ferrite/node test"
```

- [x] **Step 3: Run the new failing test**

Run:

```bash
pnpm test:release
```

Expected: FAIL because `scripts/verify-npm-packages.mjs` does not exist.

## Task 2: Implement The Release Verifier

**Files:**
- Create: `scripts/verify-npm-packages.mjs`
- Modify: `package.json`

- [x] **Step 1: Add the verifier script**

Create `scripts/verify-npm-packages.mjs` with these exports and CLI behavior:

```js
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { argv, cwd, exit } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SUPPORTED_NATIVE_PREBUILD_TARGETS } from "../packages/node/binding.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(workspaceRoot, "dist", "npm-packages");

export const RELEASE_PACKAGE_NAMES = Object.freeze([
  "@ferrite/protocol",
  "@ferrite/protocol-wasm",
  "@ferrite/runtime",
  "@ferrite/node",
]);

const RELEASE_PACKAGES = Object.freeze([
  Object.freeze({
    name: "@ferrite/protocol",
    directory: "packages/protocol",
    build: ["pnpm", ["--filter", "@ferrite/protocol", "build"]],
    requiredFiles: ["dist/index.js", "dist/index.d.ts"],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/protocol-wasm",
    directory: "packages/protocol-wasm",
    build: ["pnpm", ["--filter", "@ferrite/protocol-wasm", "build"]],
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/ferrite_protocol_wasm.wasm",
    ],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/runtime",
    directory: "packages/runtime",
    build: ["pnpm", ["--filter", "@ferrite/runtime", "build"]],
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/dom.js",
      "dist/dom.d.ts",
      "dist/jsx-runtime.js",
      "dist/jsx-runtime.d.ts",
      "dist/server.js",
      "dist/server.d.ts",
    ],
    forbiddenFiles: ["src/index.ts", "test"],
  }),
  Object.freeze({
    name: "@ferrite/node",
    directory: "packages/node",
    build: ["pnpm", ["--filter", "@ferrite/node", "build"]],
    requiredFiles: ["binding.js", "index.js", "index.d.ts"],
    forbiddenFiles: ["dist/ferrite-node.node", "scripts", "test"],
  }),
]);

export function createReleaseManifest(
  sourceManifest,
  { packageVersions, nativePackageNames, repositoryUrl } = {},
) {
  const manifest = structuredClone(sourceManifest);
  delete manifest.private;
  rewriteWorkspaceDependencies(manifest, packageVersions ?? new Map());

  if (manifest.name === "@ferrite/node") {
    manifest.optionalDependencies = {
      ...(manifest.optionalDependencies ?? {}),
      ...Object.fromEntries((nativePackageNames ?? []).map((name) => [name, manifest.version])),
    };
  }

  if (repositoryUrl) {
    manifest.repository = {
      type: "git",
      url: repositoryUrl.endsWith(".git") ? repositoryUrl : `${repositoryUrl}.git`,
      directory: packageDirectoryFor(manifest.name),
    };
    const webUrl = repositoryUrl.replace(/^git\+/, "").replace(/\.git$/, "");
    manifest.homepage = `${webUrl}#readme`;
    manifest.bugs = {
      url: `${webUrl}/issues`,
    };
  }

  return manifest;
}

export function validateManifestMetadata({
  packageName,
  sourceManifest,
  releaseManifest,
  publishManifestMode = false,
}) {
  assertString(sourceManifest.description, `${packageName}: package description is required.`);
  assertString(sourceManifest.license, `${packageName}: package license is required.`);
  assertArray(sourceManifest.keywords, `${packageName}: package keywords are required.`);
  assertArray(sourceManifest.files, `${packageName}: package files are required.`);
  if (!sourceManifest.exports || typeof sourceManifest.exports !== "object") {
    throw new Error(`${packageName}: package exports are required.`);
  }
  if (sourceManifest.publishConfig?.access !== "public") {
    throw new Error(`${packageName}: publishConfig.access must be public.`);
  }
  if (Object.hasOwn(releaseManifest, "private")) {
    throw new Error(`${packageName}: release manifest must not contain private.`);
  }
  assertNoWorkspaceSpecifiers(packageName, releaseManifest);

  if (publishManifestMode) {
    if (!releaseManifest.repository || !releaseManifest.homepage || !releaseManifest.bugs?.url) {
      throw new Error(`${packageName}: publish-manifest mode requires repository metadata.`);
    }
  }
}

export function validatePackFiles({ packageName, files, requiredFiles, forbiddenFiles }) {
  const normalized = new Set(files.map((file) => file.replace(/^package\//, "")));
  for (const required of requiredFiles) {
    if (!normalized.has(required)) {
      throw new Error(`${packageName}: packed package must include ${required}.`);
    }
  }
  for (const forbidden of forbiddenFiles) {
    if (normalized.has(forbidden) || [...normalized].some((file) => file.startsWith(`${forbidden}/`))) {
      throw new Error(`${packageName}: packed package must not include ${forbidden}.`);
    }
  }
}

export async function verifyNpmPackages({
  publishManifestMode = false,
  repositoryUrl,
  writeReports = true,
} = {}) {
  const nativePackageNames = SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => target.packageName);
  const packageVersions = new Map();
  const manifests = new Map();
  const results = [];

  for (const config of RELEASE_PACKAGES) {
    const sourceManifest = await readJson(join(workspaceRoot, config.directory, "package.json"));
    manifests.set(config.name, sourceManifest);
    packageVersions.set(config.name, sourceManifest.version);
  }

  assertAlignedVersions(packageVersions);

  for (const config of RELEASE_PACKAGES) {
    await run(config.build[0], config.build[1], { cwd: workspaceRoot });
    const packageDir = join(workspaceRoot, config.directory);
    const sourceManifest = manifests.get(config.name);
    const releaseManifest = createReleaseManifest(sourceManifest, {
      packageVersions,
      nativePackageNames,
      repositoryUrl,
    });
    validateManifestMetadata({
      packageName: config.name,
      sourceManifest,
      releaseManifest,
      publishManifestMode,
    });
    const packFiles = await npmPackDryRun(packageDir);
    validatePackFiles({
      packageName: config.name,
      files: packFiles,
      requiredFiles: config.requiredFiles,
      forbiddenFiles: config.forbiddenFiles,
    });
    results.push({
      name: config.name,
      directory: config.directory,
      version: sourceManifest.version,
      files: packFiles,
      releaseManifest,
    });
  }

  if (writeReports) {
    await rm(reportDir, { force: true, recursive: true });
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "npm-package-report.json"), `${JSON.stringify(results, null, 2)}\n`);
  }

  return results;
}

function rewriteWorkspaceDependencies(manifest, packageVersions) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        const version = packageVersions.get(name);
        if (!version) {
          throw new Error(`${manifest.name}: cannot rewrite ${field}.${name}; package version is unknown.`);
        }
        dependencies[name] = version;
      }
    }
  }
}

function assertNoWorkspaceSpecifiers(packageName, manifest) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        throw new Error(`${packageName}: release manifest contains workspace specifier ${field}.${name}.`);
      }
    }
  }
}

function assertAlignedVersions(packageVersions) {
  const versions = new Set(packageVersions.values());
  if (versions.size !== 1) {
    throw new Error(`Ferrite package versions must match: ${JSON.stringify(Object.fromEntries(packageVersions))}`);
  }
}

function packageDirectoryFor(packageName) {
  const config = RELEASE_PACKAGES.find((candidate) => candidate.name === packageName);
  if (!config) {
    throw new Error(`${packageName}: unknown release package.`);
  }
  return config.directory;
}

async function npmPackDryRun(packageDir) {
  const output = await run("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, capture: true });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`${packageDir}: npm pack --dry-run --json returned invalid JSON: ${error.message}`);
  }
  const [entry] = parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`${packageDir}: npm pack output did not include a file list.`);
  }
  return entry.files.map((file) => file.path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
}

function assertArray(value, message) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

function run(command, args, { cwd: runCwd = cwd(), capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: runCwd,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

function parseArgs(args) {
  const options = {
    publishManifestMode: false,
    repositoryUrl: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--publish-manifest") {
      options.publishManifestMode = true;
    } else if (arg === "--repository-url") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--repository-url requires a value.");
      }
      options.repositoryUrl = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.publishManifestMode && !options.repositoryUrl) {
    throw new Error("--publish-manifest requires --repository-url.");
  }
  return options;
}

async function main() {
  const options = parseArgs(argv.slice(2));
  const results = await verifyNpmPackages(options);
  for (const result of results) {
    console.log(`Verified npm package dry-run for ${result.name} with ${result.files.length} packed files.`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  });
}
```

- [x] **Step 2: Add the root release verifier command**

In `package.json`, add:

```json
"release:verify:npm": "node scripts/verify-npm-packages.mjs"
```

- [x] **Step 3: Run verifier tests**

Run:

```bash
pnpm test:release
```

Expected: PASS.

- [x] **Step 4: Commit verifier tests and implementation**

```bash
git add package.json scripts/verify-npm-packages.mjs scripts/verify-npm-packages.test.mjs
git diff --cached --check
git diff --cached
git commit -m "feat(release): verify npm package dry runs"
```

## Task 3: Add Source Package Release Metadata

**Files:**
- Modify: `packages/protocol/package.json`
- Modify: `packages/protocol-wasm/package.json`
- Modify: `packages/runtime/package.json`
- Modify: `packages/node/package.json`

- [x] **Step 1: Add package metadata to `@ferrite/protocol`**

Add these fields after `private`:

```json
"description": "Browser-safe Ferrite protocol markers, builders, and validators generated from the Rust protocol crate.",
"license": "UNLICENSED",
"keywords": ["ferrite", "protocol", "ssr", "typescript"],
"publishConfig": {
  "access": "public"
},
```

- [x] **Step 2: Add package metadata to `@ferrite/protocol-wasm`**

Add these fields after `private`:

```json
"description": "Rust-backed WASM validation for Ferrite server payload protocol packets.",
"license": "UNLICENSED",
"keywords": ["ferrite", "wasm", "protocol", "ssr"],
"publishConfig": {
  "access": "public"
},
```

- [x] **Step 3: Add package metadata to `@ferrite/runtime`**

Add these fields after `private`:

```json
"description": "TypeScript JSX runtime, DOM helpers, and server facade for the Rust-first Ferrite framework.",
"license": "UNLICENSED",
"keywords": ["ferrite", "jsx", "runtime", "typescript", "ssr"],
"publishConfig": {
  "access": "public"
},
```

- [x] **Step 4: Add package metadata to `@ferrite/node`**

Add these fields after `private`:

```json
"description": "Native Node.js bindings for Ferrite Rust server-side rendering.",
"license": "UNLICENSED",
"keywords": ["ferrite", "node-api", "native", "ssr", "rust"],
"publishConfig": {
  "access": "public"
},
```

Replace the current `files` array:

```json
"files": [
  "binding.js",
  "index.d.ts",
  "index.js"
],
```

The main package keeps source-build resolution behavior for local development, but the npm package dry-run must not include `dist/ferrite-node.node`. Platform native bindings are represented by optional native packages.

- [x] **Step 5: Verify package metadata and dry-run pack output**

Run:

```bash
pnpm release:verify:npm
```

Expected: PASS and ignored report file `dist/npm-packages/npm-package-report.json` exists.

- [x] **Step 6: Verify the package tests still pass**

Run:

```bash
pnpm test:release
```

Expected: PASS.

- [x] **Step 7: Commit source package metadata**

```bash
git add packages/protocol/package.json packages/protocol-wasm/package.json packages/runtime/package.json packages/node/package.json
git diff --cached --check
git diff --cached
git commit -m "chore(release): add npm package metadata"
```

## Task 4: Add Native Prebuild Release Metadata Checks

**Files:**
- Modify: `packages/node/scripts/create-prebuild-package.mjs`
- Modify: `packages/node/scripts/verify-prebuild-package.mjs`
- Modify: `packages/node/test/prebuild-verifier.test.mjs`

- [x] **Step 1: Extend generated native package manifests**

In `packages/node/scripts/create-prebuild-package.mjs`, add these fields to the generated `manifest` object:

```js
description: `Ferrite native Node.js binding for ${platform}/${arch}.`,
license: nodePackage.license,
keywords: nodePackage.keywords,
publishConfig: {
  access: "public",
},
```

The generated manifest must still include `name`, `version`, `os`, `cpu`, `files`, and `exports`.

- [x] **Step 2: Verify native metadata**

In `assertPackageManifest()` in `packages/node/scripts/verify-prebuild-package.mjs`, add:

```js
if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
  throw new Error(`${root}: package description is required.`);
}
if (manifest.license !== "UNLICENSED") {
  throw new Error(`${root}: package license must match @ferrite/node.`);
}
assertArrayIncludes(root, manifest.keywords, "ferrite", "keywords");
if (manifest.publishConfig?.access !== "public") {
  throw new Error(`${root}: package publishConfig.access must be public.`);
}
```

- [x] **Step 3: Update prebuild verifier fixtures**

In `packages/node/test/prebuild-verifier.test.mjs`, update fixture package manifests to include:

```js
description: `Ferrite native Node.js binding for ${os}/${cpu}.`,
license: "UNLICENSED",
keywords: ["ferrite", "node-api", "native", "ssr", "rust"],
publishConfig: {
  access: "public",
},
```

Add a failure-path test:

```js
test("rejects native packages without public publish metadata", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      publishConfig: {},
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /publishConfig\.access must be public/,
    );
  });
});
```

- [x] **Step 4: Run native prebuild tests**

Run:

```bash
pnpm --filter @ferrite/node test
```

Expected: PASS.

- [x] **Step 5: Run native prebuild package verification**

Run:

```bash
pnpm --filter @ferrite/node prebuild:package
pnpm --filter @ferrite/node prebuild:verify
```

Expected: PASS and the generated package manifest includes public release metadata.

- [x] **Step 6: Commit native package metadata checks**

```bash
git add packages/node/scripts/create-prebuild-package.mjs packages/node/scripts/verify-prebuild-package.mjs packages/node/test/prebuild-verifier.test.mjs
git diff --cached --check
git diff --cached
git commit -m "chore(node): verify native package release metadata"
```

## Task 5: Add npm Publish Dry-Run Workflow

**Files:**
- Create: `.github/workflows/npm-publish-dry-run.yml`

- [x] **Step 1: Create the read-only dry-run workflow**

Create `.github/workflows/npm-publish-dry-run.yml`:

```yaml
name: npm publish dry run

on:
  workflow_dispatch:
  pull_request:
    paths:
      - ".github/workflows/npm-publish-dry-run.yml"
      - "Cargo.lock"
      - "Cargo.toml"
      - "crates/**"
      - "packages/**"
      - "scripts/verify-npm-packages.mjs"
      - "scripts/verify-npm-packages.test.mjs"
      - "package.json"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"
  push:
    paths:
      - ".github/workflows/npm-publish-dry-run.yml"
      - "Cargo.lock"
      - "Cargo.toml"
      - "crates/**"
      - "packages/**"
      - "scripts/verify-npm-packages.mjs"
      - "scripts/verify-npm-packages.test.mjs"
      - "package.json"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"

permissions:
  contents: read

jobs:
  verify-npm-packages:
    name: Verify npm package dry-runs
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11.7.0

      - name: Setup Node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run npm package verifier tests
        run: pnpm test:release

      - name: Verify npm package dry-runs
        run: pnpm release:verify:npm

      - name: Upload npm package dry-run report
        uses: actions/upload-artifact@v4
        with:
          name: npm-package-dry-run-report
          path: dist/npm-packages
          if-no-files-found: error
```

- [x] **Step 2: Verify the workflow has no publishing credentials**

Run:

```bash
rg -n "npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|id-token: write|registry-url" .github/workflows/npm-publish-dry-run.yml
```

Expected: no matches.

- [x] **Step 3: Run the workflow's local commands**

Run:

```bash
pnpm install --frozen-lockfile
pnpm test:release
pnpm release:verify:npm
```

Expected: PASS.

- [x] **Step 4: Commit workflow**

```bash
git add .github/workflows/npm-publish-dry-run.yml
git diff --cached --check
git diff --cached
git commit -m "ci(release): add npm package dry run"
```

## Task 6: Document Milestone 061 Plan, Proof, And Boundaries

**Files:**
- Create: `docs/milestone-061-plan.md`
- Create: `docs/milestone-061-proof.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [x] **Step 1: Add milestone plan**

Create `docs/milestone-061-plan.md`:

```md
# Milestone 061 Plan: npm Publishing Prep

Goal: prove Ferrite's JavaScript-facing packages can be built and inspected as npm package dry-runs without publishing anything.

Scope:

- Add locally knowable npm package metadata to public Ferrite package manifests.
- Add a verifier for package builds, release-shaped report manifests, and `npm pack --dry-run` file output.
- Verify native prebuild package release metadata.
- Add a read-only GitHub Actions npm package dry-run workflow.
- Document proof and remote publishing gaps.

Out of scope:

- `npm publish`.
- Trusted publisher setup.
- Registry tokens or secrets.
- GitHub releases or tags.
- Publishing native prebuild packages.
- Selecting a public repository URL in a checkout with no Git remote.
```

- [x] **Step 2: Add proof document**

Create `docs/milestone-061-proof.md` with sections for `Local proof`, `Remote proof not available`, `Real publish not performed`, `Known gaps`, and `Next milestone`.

The `Known gaps` section must include:

```md
- This checkout has no configured Git remote, so repository, homepage, and issue URLs for real npm package manifests are not proven.
- npm trusted publishing is not configured.
- No registry token or npm organization access was verified.
- The npm dry-run workflow is committed locally but has not run in GitHub Actions from this checkout.
- `npm publish` was not run.
```

- [x] **Step 3: Update README commands**

In `README.md`, add these commands to the command block:

```sh
pnpm test:release
pnpm release:verify:npm
```

Add one current-boundary bullet:

```md
- npm package tarball verification for the JS-facing packages is local-only until a GitHub remote and npm publisher state are configured.
```

- [x] **Step 4: Update architecture boundary**

In `docs/architecture.md`, update the TypeScript facade package bullets to mention local npm package tarball verification.

In `## Next Milestones`, replace the first item with:

```md
1. Configure the GitHub remote and real npm publishing workflow with provenance, trusted publishing or `NPM_TOKEN`, and native prebuild artifact publication ordering.
```

- [x] **Step 5: Run docs and release checks**

Run:

```bash
pnpm test:release
pnpm release:verify:npm
pnpm lint
```

Expected: PASS.

- [x] **Step 6: Commit docs**

```bash
git add docs/milestone-061-plan.md docs/milestone-061-proof.md README.md docs/architecture.md
git diff --cached --check
git diff --cached
git commit -m "docs(release): record npm publish prep proof"
```

## Task 7: Full Local Gate And PR Readiness Check

**Files:**
- No planned source edits.

- [x] **Step 1: Run full local gates**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @ferrite/node prebuild:package
pnpm --filter @ferrite/node prebuild:verify
pnpm release:verify:npm
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Expected: all commands pass.

- [x] **Step 2: Check GitHub remote**

Run:

```bash
git remote -v
```

Expected in this checkout: no output. If no remote exists, do not push and do not claim PR proof.

- [x] **Step 3: Record final local status**

Run:

```bash
git status --short --branch
git log --oneline -8
```

Expected: branch `codex/protocol-wasm-validation`; no unstaged or staged files after the final commit.

## Spec Coverage Self-Review

- Publishable package set: Task 2 and Task 3 keep the source package set explicit.
- Package metadata: Task 3 adds locally knowable metadata; remote URL metadata is intentionally gated by publish-manifest mode.
- Release verifier: Task 1 and Task 2 add tested verifier behavior.
- Native prebuild metadata: Task 4 extends generated package manifests and verifier checks.
- Non-publishing workflow: Task 5 adds a read-only workflow with no registry credentials.
- Documentation and proof: Task 6 records local proof and unproven remote/npm state.
- Full gates and PR readiness: Task 7 runs the required local commands and confirms the current push/PR blocker.
