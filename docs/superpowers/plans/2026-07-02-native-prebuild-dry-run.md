# Native Prebuild Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-publishing GitHub Actions dry-run that builds, packages, uploads, and verifies Ferrite native Node prebuild packages.

**Architecture:** Keep native prebuild target definitions in `packages/node/binding.js` and reuse them from resolver tests and the verifier. Add a dependency-free verifier CLI that can validate one or more generated package directories locally and in CI. Add one workflow that packages every supported target on a matching hosted runner, uploads sanitized artifacts, then downloads and verifies all artifacts together.

**Tech Stack:** Node.js ESM scripts and `node:test`, Rust/Cargo native addon build, pnpm workspace scripts, GitHub Actions matrix jobs, `actions/upload-artifact`, and `actions/download-artifact`.

---

## File Structure

- Modify `packages/node/binding.js`: export supported native prebuild target metadata from the existing package mapping.
- Modify `packages/node/test/binding-resolution.test.mjs`: assert the exported target list stays aligned with the existing package-name resolver.
- Create `packages/node/scripts/verify-prebuild-package.mjs`: validate generated prebuild package directories and provide a CLI.
- Create `packages/node/test/prebuild-verifier.test.mjs`: cover verifier normal, failure, odd, and aggregate paths with temporary package fixtures.
- Modify `packages/node/package.json`: include the verifier in `typecheck` and add a `prebuild:verify` script.
- Create `.github/workflows/native-prebuild-dry-run.yml`: build and upload native prebuild artifacts for supported runners, then verify the aggregate artifact set.
- Create `docs/milestone-060-plan.md`: short milestone plan.
- Create `docs/milestone-060-proof.md`: proof notes and unproven CI limitations.
- Modify `README.md` and `docs/architecture.md`: update the current boundary without claiming npm publication.

## Task 1: Export Native Prebuild Target Metadata

**Files:**
- Modify: `packages/node/binding.js`
- Modify: `packages/node/test/binding-resolution.test.mjs`

- [ ] **Step 1: Update `binding.js` target definitions**

Replace the current `PREBUILD_PACKAGES` definition with this target list plus map:

```js
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
```

Do not change `nativePrebuildPackageName()` semantics.

- [ ] **Step 2: Add target-list assertions**

Update the import in `packages/node/test/binding-resolution.test.mjs`:

```js
import {
  NATIVE_CHECKSUM_ALGORITHM,
  SUPPORTED_NATIVE_PREBUILD_TARGETS,
  nativeBindingCandidates,
  nativePrebuildPackageName,
  resolveNativeBindingPath,
  verifyNativePrebuildChecksum,
} from "../binding.js";
```

Add this test after `nativePrebuildPackageName maps supported platforms`:

```js
test("supported native prebuild targets stay aligned with package-name mapping", () => {
  assert.deepEqual(
    SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => ({
      packageName: nativePrebuildPackageName({
        platform: target.platform,
        arch: target.arch,
      }),
      os: target.os,
      cpu: target.cpu,
    })),
    [
      { packageName: "@ferrite/node-darwin-arm64", os: "darwin", cpu: "arm64" },
      { packageName: "@ferrite/node-darwin-x64", os: "darwin", cpu: "x64" },
      { packageName: "@ferrite/node-linux-arm64-gnu", os: "linux", cpu: "arm64" },
      { packageName: "@ferrite/node-linux-x64-gnu", os: "linux", cpu: "x64" },
      { packageName: "@ferrite/node-win32-x64-msvc", os: "win32", cpu: "x64" },
    ],
  );
});
```

- [ ] **Step 3: Run focused mapping tests**

Run:

```bash
pnpm --filter @ferrite/node test
```

Expected: PASS. The command rebuilds the local native addon and all `packages/node/test/*.test.mjs` tests pass.

- [ ] **Step 4: Commit target metadata**

```bash
git add packages/node/binding.js packages/node/test/binding-resolution.test.mjs
git diff --cached --check
git diff --cached
git commit -m "refactor(node): expose native prebuild targets"
```

## Task 2: Add The Prebuild Package Verifier

**Files:**
- Create: `packages/node/scripts/verify-prebuild-package.mjs`
- Create: `packages/node/test/prebuild-verifier.test.mjs`
- Modify: `packages/node/package.json`

- [ ] **Step 1: Write failing verifier tests**

Create `packages/node/test/prebuild-verifier.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPrebuildPackageDirs } from "../scripts/verify-prebuild-package.mjs";

test("verifies a valid generated prebuild package", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
    });

    assert.deepEqual(await verifyPrebuildPackageDirs([dir]), [
      {
        packageName: "@ferrite/node-darwin-arm64",
        directory: dir,
      },
    ]);
  });
});

test("rejects checksum mismatches", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
      sha256: "0".repeat(64),
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /checksum mismatch/,
    );
  });
});

test("rejects package os and cpu that do not match the target mapping", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-linux-x64-gnu",
      os: "darwin",
      cpu: "x64",
      binding: Buffer.from("native binding"),
    });

    await assert.rejects(
      () => verifyPrebuildPackageDirs([dir]),
      /must declare os linux/,
    );
  });
});

test("rejects missing expected aggregate packages", async () => {
  await withPackageFixture(async (dir) => {
    await writePrebuildPackage(dir, {
      packageName: "@ferrite/node-darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      binding: Buffer.from("native binding"),
    });

    await assert.rejects(
      () =>
        verifyPrebuildPackageDirs([dir], {
          expectedPackages: [
            "@ferrite/node-darwin-arm64",
            "@ferrite/node-linux-x64-gnu",
          ],
        }),
      /missing expected prebuild packages: @ferrite\/node-linux-x64-gnu/,
    );
  });
});

async function withPackageFixture(callback) {
  const dir = await mkdtemp(join(tmpdir(), "ferrite-prebuild-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePrebuildPackage(dir, { packageName, os, cpu, binding, sha256 }) {
  const digest = sha256 ?? createHash("sha256").update(binding).digest("hex");
  await writeFile(join(dir, "ferrite-node.node"), binding);
  await writeFile(
    join(dir, "ferrite-node.sha256.json"),
    `${JSON.stringify(
      {
        file: "ferrite-node.node",
        algorithm: "sha256",
        sha256: digest,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        os: [os],
        cpu: [cpu],
        files: ["ferrite-node.node", "ferrite-node.sha256.json"],
        exports: {
          "./ferrite-node.node": "./ferrite-node.node",
          "./ferrite-node.sha256.json": "./ferrite-node.sha256.json",
        },
      },
      null,
      2,
    )}\n`,
  );
}
```

- [ ] **Step 2: Run verifier tests to confirm failure**

Run:

```bash
node --test packages/node/test/prebuild-verifier.test.mjs
```

Expected: FAIL with an import error because `packages/node/scripts/verify-prebuild-package.mjs` does not exist yet.

- [ ] **Step 3: Implement verifier script**

Create `packages/node/scripts/verify-prebuild-package.mjs`:

```js
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process, { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NATIVE_CHECKSUM_ALGORITHM,
  SUPPORTED_NATIVE_PREBUILD_TARGETS,
} from "../binding.js";

const checksumFile = "ferrite-node.sha256.json";
const bindingFile = "ferrite-node.node";
const supportedTargets = new Map(
  SUPPORTED_NATIVE_PREBUILD_TARGETS.map((target) => [target.packageName, target]),
);

export async function verifyPrebuildPackageDirs(directories, { expectedPackages = [] } = {}) {
  if (!Array.isArray(directories) || directories.length === 0) {
    throw new Error("At least one Ferrite native prebuild package directory is required.");
  }

  const results = [];
  for (const directory of directories) {
    results.push(await verifyPrebuildPackageDir(directory));
  }
  verifyExpectedPackages(results, expectedPackages);
  return results;
}

export async function discoverPrebuildPackageDirs(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push(join(root, entry.name));
    }
  }
  return directories.sort();
}

async function verifyPrebuildPackageDir(directory) {
  const root = resolve(directory);
  const manifest = await readJsonObject(join(root, "package.json"), "package manifest");
  const checksum = await readJsonObject(join(root, checksumFile), "checksum manifest");
  const bindingPath = join(root, bindingFile);
  const binding = await readNonEmptyFile(bindingPath, "native binding");
  const target = supportedTargets.get(manifest.name);
  if (!target) {
    throw new Error(`${root}: unsupported native prebuild package ${String(manifest.name)}.`);
  }

  await assertPackageManifest(root, manifest, target);
  assertChecksumManifest(root, checksum);
  const actual = createHash(NATIVE_CHECKSUM_ALGORITHM).update(binding).digest("hex");
  if (actual !== checksum.sha256) {
    throw new Error(
      `${root}: checksum mismatch for ${bindingFile}: expected ${checksum.sha256}, got ${actual}.`,
    );
  }

  return {
    packageName: manifest.name,
    directory: root,
  };
}

async function assertPackageManifest(root, manifest, target) {
  assertArrayEquals(root, manifest.os, [target.os], `must declare os ${target.os}`);
  assertArrayEquals(root, manifest.cpu, [target.cpu], `must declare cpu ${target.cpu}`);
  if (manifest.version !== (await nodePackageVersion())) {
    throw new Error(`${root}: package version must match @ferrite/node.`);
  }
  assertArrayIncludes(root, manifest.files, bindingFile, "files");
  assertArrayIncludes(root, manifest.files, checksumFile, "files");
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    throw new Error(`${root}: package exports must be a JSON object.`);
  }
  if (manifest.exports[`./${bindingFile}`] !== `./${bindingFile}`) {
    throw new Error(`${root}: package exports must expose ./${bindingFile}.`);
  }
  if (manifest.exports[`./${checksumFile}`] !== `./${checksumFile}`) {
    throw new Error(`${root}: package exports must expose ./${checksumFile}.`);
  }
}

function assertChecksumManifest(root, checksum) {
  if (checksum.file !== bindingFile) {
    throw new Error(`${root}: ${checksumFile} must describe ${bindingFile}.`);
  }
  if (checksum.algorithm !== NATIVE_CHECKSUM_ALGORITHM) {
    throw new Error(`${root}: ${checksumFile} must use ${NATIVE_CHECKSUM_ALGORITHM}.`);
  }
  if (typeof checksum.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksum.sha256)) {
    throw new Error(`${root}: ${checksumFile} must include a lowercase hex sha256 digest.`);
  }
}

function verifyExpectedPackages(results, expectedPackages) {
  const seen = new Map();
  for (const result of results) {
    seen.set(result.packageName, (seen.get(result.packageName) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, count]) => count !== 1).map(([name]) => name);
  if (duplicates.length > 0) {
    throw new Error(`duplicate prebuild packages: ${duplicates.join(", ")}`);
  }
  const missing = expectedPackages.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`missing expected prebuild packages: ${missing.join(", ")}`);
  }
}

let cachedNodePackageVersion;
async function nodePackageVersion() {
  if (!cachedNodePackageVersion) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    cachedNodePackageVersion = (
      await readJsonObject(join(packageRoot, "package.json"), "@ferrite/node package manifest")
    ).version;
  }
  return cachedNodePackageVersion;
}

async function readJsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid ${label}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: ${label} must be a JSON object.`);
  }
  return value;
}

async function readNonEmptyFile(path, label) {
  const file = await readFile(path);
  const fileStat = await stat(path);
  if (!fileStat.isFile() || file.length === 0) {
    throw new Error(`${path}: ${label} must be a non-empty file.`);
  }
  return file;
}

function assertArrayEquals(root, actual, expected, message) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual[0] !== expected[0]) {
    throw new Error(`${root}: package ${message}.`);
  }
}

function assertArrayIncludes(root, actual, value, field) {
  if (!Array.isArray(actual) || !actual.includes(value)) {
    throw new Error(`${root}: package ${field} must include ${value}.`);
  }
}

function parseArgs(args) {
  const directories = [];
  const expectedPackages = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expect") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--expect requires a package name.");
      }
      expectedPackages.push(value);
      index += 1;
    } else {
      directories.push(arg);
    }
  }
  return { directories, expectedPackages };
}

async function main() {
  const { directories, expectedPackages } = parseArgs(argv.slice(2));
  const resolvedDirectories = [];
  for (const directory of directories) {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new Error(`${directory}: expected a directory.`);
    }
    const childDirs = await discoverPrebuildPackageDirs(directory);
    resolvedDirectories.push(...(childDirs.length > 0 ? childDirs : [directory]));
  }
  const results = await verifyPrebuildPackageDirs(resolvedDirectories, { expectedPackages });
  for (const result of results) {
    console.log(`Verified Ferrite native prebuild package ${result.packageName} at ${result.directory}`);
  }
}

if (import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Add package scripts**

Update `packages/node/package.json` scripts:

```json
{
  "build": "cargo build -p ferrite-node && node scripts/copy-native.mjs",
  "prebuild:package": "pnpm build && node scripts/create-prebuild-package.mjs",
  "prebuild:verify": "node scripts/verify-prebuild-package.mjs dist/prebuild",
  "test": "pnpm build && node --test test/*.test.mjs",
  "typecheck": "node --check binding.js && node --check index.js && node --check scripts/copy-native.mjs && node --check scripts/create-prebuild-package.mjs && node --check scripts/verify-prebuild-package.mjs"
}
```

- [ ] **Step 5: Run focused verifier tests**

Run:

```bash
node --test packages/node/test/prebuild-verifier.test.mjs
pnpm --filter @ferrite/node typecheck
pnpm --filter @ferrite/node test
pnpm --filter @ferrite/node prebuild:package
pnpm --filter @ferrite/node prebuild:verify
```

Expected: all commands PASS. The verifier reports the generated current-platform package.

- [ ] **Step 6: Commit verifier**

```bash
git add packages/node/binding.js packages/node/package.json packages/node/scripts/verify-prebuild-package.mjs packages/node/test/binding-resolution.test.mjs packages/node/test/prebuild-verifier.test.mjs
git diff --cached --check
git diff --cached --stat
git commit -m "feat(node): verify native prebuild packages"
```

## Task 3: Add Native Prebuild Dry-Run Workflow

**Files:**
- Create: `.github/workflows/native-prebuild-dry-run.yml`

- [ ] **Step 1: Create workflow**

Create `.github/workflows/native-prebuild-dry-run.yml`:

```yaml
name: Native prebuild dry run

on:
  workflow_dispatch:
  pull_request:
    paths:
      - ".github/workflows/native-prebuild-dry-run.yml"
      - "Cargo.lock"
      - "Cargo.toml"
      - "crates/ferrite-node/**"
      - "crates/ferrite-ssr/**"
      - "crates/ferrite-core/**"
      - "crates/ferrite-protocol/**"
      - "packages/node/**"
      - "package.json"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"
  push:
    paths:
      - ".github/workflows/native-prebuild-dry-run.yml"
      - "Cargo.lock"
      - "Cargo.toml"
      - "crates/ferrite-node/**"
      - "crates/ferrite-ssr/**"
      - "crates/ferrite-core/**"
      - "crates/ferrite-protocol/**"
      - "packages/node/**"
      - "package.json"
      - "pnpm-lock.yaml"
      - "pnpm-workspace.yaml"

permissions:
  contents: read

jobs:
  build-native-prebuild:
    name: Build ${{ matrix.package }}
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - package: "@ferrite/node-darwin-arm64"
            artifact: ferrite-node-darwin-arm64
            runner: macos-latest
          - package: "@ferrite/node-darwin-x64"
            artifact: ferrite-node-darwin-x64
            runner: macos-13
          - package: "@ferrite/node-linux-arm64-gnu"
            artifact: ferrite-node-linux-arm64-gnu
            runner: ubuntu-24.04-arm
          - package: "@ferrite/node-linux-x64-gnu"
            artifact: ferrite-node-linux-x64-gnu
            runner: ubuntu-latest
          - package: "@ferrite/node-win32-x64-msvc"
            artifact: ferrite-node-win32-x64-msvc
            runner: windows-latest

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

      - name: Build native prebuild package
        run: pnpm --filter @ferrite/node prebuild:package

      - name: Verify native prebuild package
        run: pnpm --filter @ferrite/node prebuild:verify -- --expect "${{ matrix.package }}"

      - name: Upload native prebuild package
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: packages/node/dist/prebuild
          if-no-files-found: error

  verify-native-prebuilds:
    name: Verify native prebuild artifact set
    runs-on: ubuntu-latest
    needs: build-native-prebuild

    steps:
      - name: Checkout
        uses: actions/checkout@v6

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

      - name: Download native prebuild artifacts
        uses: actions/download-artifact@v5
        with:
          path: packages/node/dist/prebuild-artifacts

      - name: Verify all native prebuild artifacts
        run: >
          node packages/node/scripts/verify-prebuild-package.mjs
          packages/node/dist/prebuild-artifacts
          --expect @ferrite/node-darwin-arm64
          --expect @ferrite/node-darwin-x64
          --expect @ferrite/node-linux-arm64-gnu
          --expect @ferrite/node-linux-x64-gnu
          --expect @ferrite/node-win32-x64-msvc
```

- [ ] **Step 2: Run YAML-adjacent validation**

Run:

```bash
git diff --check -- .github/workflows/native-prebuild-dry-run.yml
```

Expected: no whitespace errors.

- [ ] **Step 3: Commit workflow**

```bash
git add .github/workflows/native-prebuild-dry-run.yml
git diff --cached --check
git diff --cached
git commit -m "ci(node): add native prebuild dry run"
```

## Task 4: Add Milestone Docs And Boundary Updates

**Files:**
- Create: `docs/milestone-060-plan.md`
- Create: `docs/milestone-060-proof.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add milestone plan**

Create `docs/milestone-060-plan.md`:

```markdown
# Milestone 060 Plan: Native Prebuild Dry-Run Release

Goal: prove Ferrite can build and validate supported native Node prebuild packages in a non-publishing release workflow.

Scope:

- Add a GitHub Actions dry-run workflow for supported native prebuild packages.
- Add a verifier script for generated prebuild package directories.
- Verify package metadata, expected files, and SHA-256 manifests.
- Upload generated packages as CI artifacts.
- Document local proof and remaining release limits.

Out of scope:

- npm publication.
- GitHub releases.
- Code signing or notarization.
- Cross-compiled native prebuilds.
- Runtime API changes.
```

- [ ] **Step 2: Add milestone proof**

Create `docs/milestone-060-proof.md`:

```markdown
# Milestone 060 Proof: Native Prebuild Dry-Run Release

## Changed

- Added supported native prebuild target metadata shared by resolver tests and package verification.
- Added `packages/node/scripts/verify-prebuild-package.mjs` to validate generated native prebuild package directories.
- Added focused verifier tests for valid packages, checksum mismatch, metadata mismatch, and missing aggregate packages.
- Added `.github/workflows/native-prebuild-dry-run.yml` to build, upload, and aggregate-verify native prebuild artifacts on supported hosted runners.
- Updated docs to describe dry-run release automation without claiming npm publication.

## Why

Ferrite can already generate checksum-backed optional native packages locally. This milestone makes the release path production-shaped by adding a repeatable CI dry run that proves package generation and verification across supported runner families before npm publishing exists.

## Proof

- `node --test packages/node/test/prebuild-verifier.test.mjs`
- `pnpm --filter @ferrite/node typecheck`
- `pnpm --filter @ferrite/node test`
- `pnpm --filter @ferrite/node prebuild:package`
- `pnpm --filter @ferrite/node prebuild:verify`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm typecheck`
- `pnpm render:fixture`
- `pnpm dev:once`
- `pnpm build:example`

## Focused Coverage

- Normal path: a generated current-platform prebuild package passes verifier checks.
- Failure path: checksum mismatches fail before publication.
- Odd path: package names with mismatched `os` or `cpu` metadata fail clearly.
- Aggregate path: missing expected package artifacts fail the aggregate verifier.

## Not Proven

- Actual GitHub workflow execution, because this local repository has no configured remote.
- npm package publication.
- GitHub release creation.
- Code signing or notarization.
- Availability of every hosted runner in the matrix at execution time.
```

- [ ] **Step 3: Update README boundary**

In `README.md`, update the feature list and current boundaries to mention dry-run native prebuild release automation. Keep the statement that npm publication is not done.

- [ ] **Step 4: Update architecture boundary**

In `docs/architecture.md`, update the native package text and next milestones so the next release milestone is publish preparation rather than dry-run packaging.

- [ ] **Step 5: Commit docs**

```bash
git add README.md docs/architecture.md docs/milestone-060-plan.md docs/milestone-060-proof.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs(release): record native prebuild dry run proof"
```

## Task 5: Full Verification And Final Review

**Files:**
- Review all changed files from Tasks 1-4.

- [ ] **Step 1: Run focused release proof**

Run:

```bash
pnpm --filter @ferrite/node prebuild:package
pnpm --filter @ferrite/node prebuild:verify
```

Expected: PASS. The verifier reports the generated current-platform package.

- [ ] **Step 2: Run normal repository gates**

Run:

```bash
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm render:fixture
pnpm dev:once
pnpm build:example
```

Expected: all commands PASS.

- [ ] **Step 3: Inspect final history and tree**

Run:

```bash
git status --short --branch
git log --oneline --decorate -10
git remote -v
```

Expected: tracked worktree is clean. If `git remote -v` is empty, document that push and PR remain blocked by missing remote.

- [ ] **Step 4: Push and open PR if a remote exists**

Run only if `git remote -v` shows a GitHub remote:

```bash
git push -u origin codex/protocol-wasm-validation
```

Then open a PR summarizing:

- Native prebuild verifier and tests.
- Dry-run workflow artifact matrix.
- Local proof commands.
- CI proof status.
- Known gap if any hosted runner is unavailable.

Expected: branch pushes successfully and PR URL is recorded.

- [ ] **Step 5: If no remote exists, stop before push**

If `git remote -v` is empty, do not fabricate a PR. Report the committed local work, verification commands, and the remote blocker.
