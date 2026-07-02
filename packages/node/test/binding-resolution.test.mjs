import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  nativeBindingCandidates,
  nativePrebuildPackageName,
  resolveNativeBindingPath,
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
  assert.equal(
    resolveNativeBindingPath({
      env: {},
      packageRoot: "/package",
      platform: "darwin",
      arch: "arm64",
      requireFunction: fakeRequireFunction({ "@ferrite/node-darwin-arm64/ferrite-node.node": "/prebuild.node" }),
      existsSync: (path) => path === "/prebuild.node",
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
      required: false,
    },
  ]);
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
