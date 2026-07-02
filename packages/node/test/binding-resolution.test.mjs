import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  NATIVE_CHECKSUM_ALGORITHM,
  SUPPORTED_NATIVE_PREBUILD_TARGETS,
  nativeBindingCandidates,
  nativePrebuildPackageName,
  resolveNativeBindingPath,
  verifyNativePrebuildChecksum,
} from "../binding.js";

test("nativePrebuildPackageName maps supported platforms", () => {
  assert.equal(
    nativePrebuildPackageName({ platform: "darwin", arch: "arm64" }),
    "@ferrite/node-darwin-arm64",
  );
  assert.equal(
    nativePrebuildPackageName({ platform: "linux", arch: "x64" }),
    "@ferrite/node-linux-x64-gnu",
  );
  assert.equal(nativePrebuildPackageName({ platform: "freebsd", arch: "x64" }), null);
});

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

test("resolveNativeBindingPath honors explicit environment overrides", () => {
  const binding = "/tmp/ferrite-custom.node";

  assert.equal(
    resolveNativeBindingPath({
      env: { FERRITE_NODE_BINDING: binding },
      cwd: "/workspace",
      existsSync: (path) => path === binding,
    }),
    binding,
  );
});

test("resolveNativeBindingPath does not fall back when an override is missing", () => {
  assert.throws(
    () =>
      resolveNativeBindingPath({
        env: { FERRITE_NODE_BINDING: "missing.node" },
        cwd: "/workspace",
        packageRoot: "/package",
        existsSync: (path) => path === "/package/dist/ferrite-node.node",
      }),
    /FERRITE_NODE_BINDING/,
  );
});

test("resolveNativeBindingPath prefers local source builds", () => {
  const local = join("/package", "dist", "ferrite-node.node");

  assert.equal(
    resolveNativeBindingPath({
      env: {},
      packageRoot: "/package",
      platform: "darwin",
      arch: "arm64",
      requireFunction: fakeRequireFunction({ "@ferrite/node-darwin-arm64/ferrite-node.node": "/prebuild.node" }),
      existsSync: (path) => path === local || path === "/prebuild.node",
    }),
    local,
  );
});

test("resolveNativeBindingPath falls back to an installed optional prebuild package", () => {
  const binding = Buffer.from("native binding");
  const checksum = "423757b51b6ba428cba402cce842df21cc26b27e352a5caa755b786e56430ef0";

  assert.equal(
    resolveNativeBindingPath({
      env: {},
      packageRoot: "/package",
      platform: "darwin",
      arch: "arm64",
      requireFunction: fakeRequireFunction({
        "@ferrite/node-darwin-arm64/ferrite-node.node": "/prebuild.node",
        "@ferrite/node-darwin-arm64/ferrite-node.sha256.json": "/checksum.json",
      }),
      existsSync: (path) => path === "/prebuild.node",
      readFileSync: fakeReadFileSync({
        "/prebuild.node": binding,
        "/checksum.json": JSON.stringify({
          file: "ferrite-node.node",
          algorithm: NATIVE_CHECKSUM_ALGORITHM,
          sha256: checksum,
        }),
      }),
    }),
    "/prebuild.node",
  );
});

test("resolveNativeBindingPath reports unsupported platforms clearly", () => {
  assert.throws(
    () =>
      resolveNativeBindingPath({
        env: {},
        packageRoot: "/package",
        platform: "freebsd",
        arch: "x64",
        existsSync: () => false,
      }),
    /No optional prebuild package is defined for freebsd\/x64/,
  );
});

test("nativeBindingCandidates records missing optional packages without throwing", () => {
  const candidates = nativeBindingCandidates({
    env: {},
    packageRoot: "/package",
    platform: "darwin",
    arch: "arm64",
    requireFunction: fakeRequireFunction({}),
  });

  assert.deepEqual(candidates, [
    {
      kind: "local",
      path: join("/package", "dist", "ferrite-node.node"),
      required: false,
    },
    {
      kind: "prebuild",
      packageName: "@ferrite/node-darwin-arm64",
      path: null,
      checksumPath: null,
      required: false,
    },
  ]);
});

test("resolveNativeBindingPath rejects optional prebuilds without checksums", () => {
  assert.throws(
    () =>
      resolveNativeBindingPath({
        env: {},
        packageRoot: "/package",
        platform: "darwin",
        arch: "arm64",
        requireFunction: fakeRequireFunction({
          "@ferrite/node-darwin-arm64/ferrite-node.node": "/prebuild.node",
        }),
        existsSync: (path) => path === "/prebuild.node",
      }),
    /must include ferrite-node\.sha256\.json/,
  );
});

test("verifyNativePrebuildChecksum rejects mismatched checksums", () => {
  assert.throws(
    () =>
      verifyNativePrebuildChecksum({
        bindingPath: "/prebuild.node",
        checksumPath: "/checksum.json",
        packageName: "@ferrite/node-darwin-arm64",
        readFileSync: fakeReadFileSync({
          "/prebuild.node": Buffer.from("native binding"),
          "/checksum.json": JSON.stringify({
            file: "ferrite-node.node",
            algorithm: NATIVE_CHECKSUM_ALGORITHM,
            sha256: "0".repeat(64),
          }),
        }),
      }),
    /checksum mismatch/,
  );
});

test("verifyNativePrebuildChecksum rejects malformed checksum manifests", () => {
  assert.throws(
    () =>
      verifyNativePrebuildChecksum({
        bindingPath: "/prebuild.node",
        checksumPath: "/checksum.json",
        packageName: "@ferrite/node-darwin-arm64",
        readFileSync: fakeReadFileSync({
          "/prebuild.node": Buffer.from("native binding"),
          "/checksum.json": JSON.stringify({
            file: "ferrite-node.node",
            algorithm: "md5",
            sha256: "0".repeat(64),
          }),
        }),
      }),
    /unsupported algorithm/,
  );
});

function fakeRequireFunction(resolutions) {
  return {
    resolve(specifier) {
      if (Object.hasOwn(resolutions, specifier)) {
        return resolutions[specifier];
      }
      throw new Error(`Cannot find module ${specifier}`);
    },
  };
}

function fakeReadFileSync(files) {
  return (path) => {
    if (Object.hasOwn(files, path)) {
      return files[path];
    }
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  };
}
