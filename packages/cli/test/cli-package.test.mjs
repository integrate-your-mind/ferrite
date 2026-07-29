import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CLI_CHECKSUM_ALGORITHM,
  cliTarget,
  isExactSemver,
  launchFerrite,
  resolveCliBinary,
  verifyChecksumManifest,
} from "../lib/cli-package.js";

const binary = Buffer.from("ferrite cli binary");
const sha256 = createHash(CLI_CHECKSUM_ALGORITHM).update(binary).digest("hex");

test("cliTarget exposes only the verified current-host package", () => {
  assert.equal(
    cliTarget({ platform: "darwin", arch: "arm64" })?.packageName,
    "@ferrite/cli-darwin-arm64",
  );
  assert.equal(cliTarget({ platform: "darwin", arch: "x64" }), null);
  assert.equal(cliTarget({ platform: "linux", arch: "arm64" }), null);
});

test("isExactSemver rejects tags, ranges, and ambiguous numeric identifiers", () => {
  for (const version of ["0.1.0", "0.1.0-alpha.0", "1.2.3+build.7"]) {
    assert.equal(isExactSemver(version), true, version);
  }
  for (const version of [
    "",
    "latest",
    "^1.2.3",
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3+",
  ]) {
    assert.equal(isExactSemver(version), false, version);
  }
});

test("resolveCliBinary verifies package metadata, mode, size, and checksum", () => {
  const files = validFiles();
  const resolved = resolveCliBinary({
    platform: "darwin",
    arch: "arm64",
    packageRoot: "/wrapper",
    requireFunction: fakeRequire({
      "@ferrite/cli-darwin-arm64/bin/ferrite": "/platform/bin/ferrite",
      "@ferrite/cli-darwin-arm64/ferrite-cli.sha256.json": "/platform/checksum.json",
      "@ferrite/cli-darwin-arm64/package.json": "/platform/package.json",
    }),
    readFileSync: fakeRead(files),
    statSync: () => ({ isFile: () => true, mode: 0o100755 }),
  });

  assert.deepEqual(resolved, {
    path: "/platform/bin/ferrite",
    packageName: "@ferrite/cli-darwin-arm64",
    packageVersion: "0.1.0-alpha.0",
  });
});

test("resolveCliBinary fails closed on unsupported hosts", () => {
  assert.throws(
    () => resolveCliBinary({ platform: "linux", arch: "x64" }),
    /supports only darwin\/arm64/,
  );
});

test("resolveCliBinary names an omitted optional package", () => {
  assert.throws(
    () =>
      resolveCliBinary({
        platform: "darwin",
        arch: "arm64",
        packageRoot: "/wrapper",
        requireFunction: fakeRequire({}),
        readFileSync: fakeRead({
          "/wrapper/package.json": JSON.stringify({
            name: "@ferrite/cli",
            version: "0.1.0-alpha.0",
          }),
        }),
      }),
    /@ferrite\/cli-darwin-arm64@0\.1\.0-alpha\.0 is not installed/,
  );
});

test("resolveCliBinary rejects mismatched platform package versions", () => {
  const files = validFiles();
  files["/platform/package.json"] = JSON.stringify({
    name: "@ferrite/cli-darwin-arm64",
    version: "0.1.0-alpha.1",
    os: ["darwin"],
    cpu: ["arm64"],
  });

  assert.throws(
    () =>
      resolveCliBinary({
        platform: "darwin",
        arch: "arm64",
        packageRoot: "/wrapper",
        requireFunction: validRequire(),
        readFileSync: fakeRead(files),
        statSync: () => ({ isFile: () => true, mode: 0o100755 }),
      }),
    /does not match @ferrite\/cli/,
  );
});

test("resolveCliBinary rejects a non-executable binary", () => {
  assert.throws(
    () =>
      resolveCliBinary({
        platform: "darwin",
        arch: "arm64",
        packageRoot: "/wrapper",
        requireFunction: validRequire(),
        readFileSync: fakeRead(validFiles()),
        statSync: () => ({ isFile: () => true, mode: 0o100644 }),
      }),
    /not executable/,
  );
});

test("verifyChecksumManifest rejects size and digest tampering", () => {
  const manifest = {
    file: "bin/ferrite",
    algorithm: "sha256",
    packageVersion: "0.1.0-alpha.0",
    bytes: binary.length,
    sha256,
  };

  assert.throws(
    () =>
      verifyChecksumManifest(
        { ...manifest, bytes: binary.length + 1 },
        checksumOptions(),
      ),
    /binary size mismatch/,
  );
  assert.throws(
    () =>
      verifyChecksumManifest(
        { ...manifest, sha256: "0".repeat(64) },
        checksumOptions(),
      ),
    /checksum mismatch/,
  );
});

test("launchFerrite passes exact argv and a wrapper-owned npm version", () => {
  let invocation;
  const result = launchFerrite(["init", "app with spaces"], {
    env: {
      KEEP: "yes",
      FERRITE_NPM_PACKAGE_VERSION: "attacker-controlled",
    },
    resolveBinary: () => ({
      path: "/verified/ferrite",
      packageVersion: "0.1.0-alpha.0",
    }),
    spawnSync(path, args, options) {
      invocation = { path, args, options };
      return { status: 17, signal: null };
    },
  });

  assert.deepEqual(result, { status: 17, signal: null });
  assert.equal(invocation.path, "/verified/ferrite");
  assert.deepEqual(invocation.args, ["init", "app with spaces"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.KEEP, "yes");
  assert.equal(
    invocation.options.env.FERRITE_NPM_PACKAGE_VERSION,
    "0.1.0-alpha.0",
  );
});

test("launchFerrite preserves signal outcomes and reports spawn errors", () => {
  const resolved = () => ({
    path: "/verified/ferrite",
    packageVersion: "0.1.0-alpha.0",
  });
  assert.deepEqual(
    launchFerrite([], {
      resolveBinary: resolved,
      spawnSync: () => ({ status: null, signal: "SIGTERM" }),
    }),
    { status: null, signal: "SIGTERM" },
  );
  assert.throws(
    () =>
      launchFerrite([], {
        resolveBinary: resolved,
        spawnSync: () => ({
          status: null,
          signal: null,
          error: new Error("ENOENT"),
        }),
      }),
    /failed to launch.*ENOENT/,
  );
});

function checksumOptions() {
  return {
    binary,
    binaryFile: "bin/ferrite",
    packageName: "@ferrite/cli-darwin-arm64",
    packageVersion: "0.1.0-alpha.0",
  };
}

function validFiles() {
  return {
    "/wrapper/package.json": JSON.stringify({
      name: "@ferrite/cli",
      version: "0.1.0-alpha.0",
    }),
    "/platform/package.json": JSON.stringify({
      name: "@ferrite/cli-darwin-arm64",
      version: "0.1.0-alpha.0",
      os: ["darwin"],
      cpu: ["arm64"],
    }),
    "/platform/checksum.json": JSON.stringify({
      file: "bin/ferrite",
      algorithm: "sha256",
      packageVersion: "0.1.0-alpha.0",
      bytes: binary.length,
      sha256,
    }),
    "/platform/bin/ferrite": binary,
  };
}

function validRequire() {
  return fakeRequire({
    "@ferrite/cli-darwin-arm64/bin/ferrite": "/platform/bin/ferrite",
    "@ferrite/cli-darwin-arm64/ferrite-cli.sha256.json": "/platform/checksum.json",
    "@ferrite/cli-darwin-arm64/package.json": "/platform/package.json",
  });
}

function fakeRequire(resolutions) {
  return {
    resolve(specifier) {
      if (Object.hasOwn(resolutions, specifier)) return resolutions[specifier];
      throw new Error(`Cannot find ${specifier}`);
    },
  };
}

function fakeRead(files) {
  return (path) => {
    if (Object.hasOwn(files, path)) return files[path];
    throw new Error(`ENOENT: ${path}`);
  };
}
