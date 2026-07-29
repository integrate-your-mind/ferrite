import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, execPath, kill } from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLI_CHECKSUM_ALGORITHM,
  cliTarget,
  ferriteBinaryVersionForPackage,
  isExactSemver,
  launchFerrite,
  materializeVerifiedBinary,
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

test("ferriteBinaryVersionForPackage binds npm prereleases to the Cargo core", () => {
  assert.equal(
    ferriteBinaryVersionForPackage("0.1.0-alpha.0"),
    "ferrite 0.1.0",
  );
  assert.equal(
    ferriteBinaryVersionForPackage("1.2.3+build.7"),
    "ferrite 1.2.3",
  );
  assert.throws(
    () => ferriteBinaryVersionForPackage("latest"),
    /exact semantic version/,
  );
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
    binary,
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
            optionalDependencies: {
              "@ferrite/cli-darwin-arm64": "0.1.0-alpha.0",
            },
          }),
        }),
      }),
    /@ferrite\/cli-darwin-arm64@0\.1\.0-alpha\.0 is not installed/,
  );
});

test("resolveCliBinary rejects a mismatched optional package declaration", () => {
  const files = validFiles();
  files["/wrapper/package.json"] = JSON.stringify({
    name: "@ferrite/cli",
    version: "0.1.0-alpha.0",
    optionalDependencies: {
      "@ferrite/cli-darwin-arm64": "0.1.0-alpha.1",
    },
  });
  assert.throws(
    () =>
      resolveCliBinary({
        platform: "darwin",
        arch: "arm64",
        packageRoot: "/wrapper",
        requireFunction: validRequire(),
        readFileSync: fakeRead(files),
      }),
    /must declare exact optional dependency/,
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

test("resolveCliBinary rejects a symbolic-link binary", () => {
  assert.throws(
    () =>
      resolveCliBinary({
        platform: "darwin",
        arch: "arm64",
        packageRoot: "/wrapper",
        requireFunction: validRequire(),
        readFileSync: fakeRead(validFiles()),
        statSync: () => ({
          isFile: () => true,
          isSymbolicLink: () => true,
          mode: 0o100755,
        }),
      }),
    /must not be a symbolic link/,
  );
});

test("materializeVerifiedBinary creates and removes a private executable snapshot", async () => {
  const snapshot = await materializeVerifiedBinary(binary);
  assert.deepEqual(await readFile(snapshot.path), binary);
  assert.notEqual((await lstat(snapshot.path)).mode & 0o111, 0);

  await snapshot.cleanup();

  await assert.rejects(lstat(snapshot.path), { code: "ENOENT" });
});

test("materializeVerifiedBinary reports creation and cleanup failures together", async () => {
  await assert.rejects(
    materializeVerifiedBinary(binary, {
      temporaryRoot: "/private",
      mkdtemp: async () => "/private/ferrite-cli-failed",
      writeFile: async () => {
        throw new Error("injected snapshot write failure");
      },
      rm: async () => {
        throw new Error("injected snapshot cleanup failure");
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((entry) => /snapshot write failure/.test(entry.message)) &&
      error.errors.some((entry) => /snapshot cleanup failure/.test(entry.message)),
  );
});

test("verifyChecksumManifest rejects size and digest tampering", () => {
  const manifest = {
    file: "bin/ferrite",
    algorithm: "sha256",
    packageVersion: "0.1.0-alpha.0",
    runtimeVersion: "0.1.0-alpha.0",
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
  assert.throws(
    () =>
      verifyChecksumManifest(
        { ...manifest, runtimeVersion: "0.1.0-alpha.1" },
        checksumOptions(),
      ),
    /runtime version.*does not match/,
  );
});

test("launchFerrite passes exact argv and a wrapper-owned npm version", async () => {
  let invocation;
  const processObject = new EventEmitter();
  const result = await launchFerrite(["init", "app with spaces"], {
    env: {
      KEEP: "yes",
      FERRITE_INTERNAL_NPM_PACKAGE_VERSION: "attacker-controlled",
    },
    resolveBinary: () => ({
      path: "/verified/ferrite",
      packageVersion: "0.1.0-alpha.0",
    }),
    spawn(path, args, options) {
      invocation = { path, args, options };
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 17, null));
      return child;
    },
    processObject,
  });

  assert.deepEqual(result, { status: 17, signal: null });
  assert.equal(invocation.path, "/verified/ferrite");
  assert.deepEqual(invocation.args, ["init", "app with spaces"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.KEEP, "yes");
  assert.equal(
    invocation.options.env.FERRITE_INTERNAL_NPM_PACKAGE_VERSION,
    "0.1.0-alpha.0",
  );
  assert.equal(processObject.listenerCount("SIGTERM"), 0);
});

test("launchFerrite executes the verified snapshot and removes it after exit", async () => {
  let cleaned = false;
  let invocationPath;
  const result = await launchFerrite(["--version"], {
    resolveBinary: () => ({
      path: "/installed/ferrite",
      binary,
      packageVersion: "0.1.0-alpha.0",
    }),
    async materializeBinary(bytes, options) {
      assert.deepEqual(bytes, binary);
      assert.equal(options.binaryFile, "ferrite");
      return {
        path: "/private/snapshot/ferrite",
        async cleanup() {
          cleaned = true;
        },
      };
    },
    spawn(path) {
      invocationPath = path;
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    processObject: new EventEmitter(),
  });

  assert.deepEqual(result, { status: 0, signal: null });
  assert.equal(invocationPath, "/private/snapshot/ferrite");
  assert.equal(cleaned, true);
});

test("launchFerrite removes the verified snapshot after a synchronous spawn failure", async () => {
  let cleaned = false;
  await assert.rejects(
    launchFerrite([], {
      resolveBinary: () => ({
        path: "/installed/ferrite",
        binary,
        packageVersion: "0.1.0-alpha.0",
      }),
      async materializeBinary() {
        return {
          path: "/private/snapshot/ferrite",
          async cleanup() {
            cleaned = true;
          },
        };
      },
      spawn() {
        throw new Error("injected spawn failure");
      },
    }),
    /injected spawn failure/,
  );
  assert.equal(cleaned, true);
});

test("launchFerrite preserves signal outcomes and reports spawn errors", async () => {
  const resolved = () => ({
    path: "/verified/ferrite",
    packageVersion: "0.1.0-alpha.0",
  });
  assert.deepEqual(
    await launchFerrite([], {
      resolveBinary: resolved,
      processObject: new EventEmitter(),
      spawn: () => {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return child;
      },
    }),
    { status: null, signal: "SIGTERM" },
  );
  await assert.rejects(
    async () =>
      launchFerrite([], {
        resolveBinary: resolved,
        processObject: new EventEmitter(),
        spawn: () => {
          const child = new EventEmitter();
          child.kill = () => true;
          queueMicrotask(() => child.emit("error", new Error("ENOENT")));
          return child;
        },
      }),
    /failed to launch.*ENOENT/,
  );
});

test("launchFerrite forwards wrapper signals and removes its listeners", async () => {
  const processObject = new EventEmitter();
  let forwardedSignal;
  const result = await launchFerrite([], {
    resolveBinary: () => ({
      path: "/verified/ferrite",
      packageVersion: "0.1.0-alpha.0",
    }),
    processObject,
    spawn: () => {
      const child = new EventEmitter();
      child.kill = (signal) => {
        forwardedSignal = signal;
        queueMicrotask(() => child.emit("close", 0, null));
        return true;
      };
      queueMicrotask(() => processObject.emit("SIGTERM"));
      return child;
    },
  });

  assert.deepEqual(result, { status: null, signal: "SIGTERM" });
  assert.equal(forwardedSignal, "SIGTERM");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(processObject.listenerCount(signal), 0);
  }
});

test("launchFerrite removes signal listeners when forwarding fails", async () => {
  const processObject = new EventEmitter();
  await assert.rejects(
    launchFerrite([], {
      resolveBinary: () => ({
        path: "/verified/ferrite",
        packageVersion: "0.1.0-alpha.0",
      }),
      processObject,
      spawn: () => {
        const child = new EventEmitter();
        child.kill = () => {
          throw new Error("injected signal forwarding failure");
        };
        queueMicrotask(() => processObject.emit("SIGTERM"));
        return child;
      },
    }),
    /failed to launch.*signal forwarding failure/,
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(processObject.listenerCount(signal), 0);
  }
});

test(
  "the npm wrapper forwards SIGTERM and leaves no child process",
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ferrite cli signal "));
    const pidFile = join(root, "child.pid");
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, "..", "lib", "cli-package.js"),
    ).href;
    const childProgram = [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.FERRITE_TEST_CHILD_PID, String(process.pid));',
      "setInterval(() => {}, 1_000);",
    ].join("");
    const wrapperProgram = [
      `import { launchFerrite } from ${JSON.stringify(moduleUrl)};`,
      `const result = await launchFerrite(["--input-type=module", "--eval", ${JSON.stringify(childProgram)}], {`,
      "  resolveBinary: () => ({ path: process.execPath, packageVersion: \"0.1.0-alpha.0\" }),",
      "});",
      "if (result.signal) {",
      "  process.exitCode = 1;",
      "  process.kill(process.pid, result.signal);",
      "} else {",
      "  process.exitCode = result.status;",
      "}",
    ].join("\n");
    const wrapper = spawnProcess(
      execPath,
      ["--input-type=module", "--eval", wrapperProgram],
      {
        env: { ...env, FERRITE_TEST_CHILD_PID: pidFile },
        stdio: "ignore",
      },
    );
    let childPid;

    try {
      childPid = Number(await waitForFile(pidFile));
      assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
      wrapper.kill("SIGTERM");
      const outcome = await waitForClose(wrapper);
      assert.deepEqual(outcome, { status: null, signal: "SIGTERM" });
      await waitForProcessExit(childPid);
    } finally {
      if (isProcessAlive(wrapper.pid)) wrapper.kill("SIGKILL");
      if (childPid && isProcessAlive(childPid)) kill(childPid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      optionalDependencies: {
        "@ferrite/cli-darwin-arm64": "0.1.0-alpha.0",
      },
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
      runtimeVersion: "0.1.0-alpha.0",
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

async function waitForFile(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Child process ${pid} survived wrapper termination.`);
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
