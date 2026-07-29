import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  bootstrapCargo,
  buildPlan,
  buildSitesSource,
  decompressXzArchive,
  DEFAULT_SITE_ORIGIN,
  installZigLinker,
  readBoundedBody,
  replaceSiteOutput,
  run,
  resolveXzReadableStream,
  resolveCargo,
  RUST_TOOLCHAIN,
  RUSTUP_INIT_SHA256,
  RUSTUP_INIT_URL,
  RUSTUP_TARGET,
  rustBootstrapSupported,
  sha256,
  SITE_OUTPUT_ENTRIES,
  SITE_OUTPUT_LOCK,
  siteOrigin,
  SYSTEM_TAR,
  writeVerifiedBody,
  ZIG_ARCHIVE_SHA256,
  ZIG_ARCHIVE_URL,
  ZIG_VERSION,
} from "./build-sites-source.mjs";

async function writeSiteOutput(root, marker) {
  for (const name of SITE_OUTPUT_ENTRIES) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "marker.txt"), `${marker}:${name}`);
  }
}

function responseFor(bytes, options = {}) {
  const headers = new Headers();
  if (options.contentLength !== null) {
    headers.set(
      "content-length",
      String(options.contentLength ?? bytes.length),
    );
  }
  return {
    body: new Response(bytes).body,
    headers,
    ok: options.ok ?? true,
    status: options.status ?? 200,
    url: options.url ?? RUSTUP_INIT_URL,
  };
}

test("Sites source build uses the production Ferrite subdomain by default", () => {
  assert.equal(siteOrigin(), DEFAULT_SITE_ORIGIN);
  assert.equal(
    siteOrigin("https://preview.example.test"),
    "https://preview.example.test",
  );
});

test("Sites source build rejects ambiguous or unsafe origins", () => {
  for (const value of [
    "http://ferrite.mondello.dev",
    "https://user@example.test",
    "https://example.test/path",
    "https://example.test/?query=1",
    "https://example.test/#fragment",
  ]) {
    assert.throws(() => siteOrigin(value), /must be an HTTPS origin/);
  }
});

test("Sites source build avoids recursive package-manager scripts", () => {
  const plan = buildPlan("/trusted/cargo", {
    artifactDirectory: "/isolated/artifact",
    distDirectory: "/isolated/dist",
    typesOutput: "/isolated/types/routes.d.ts",
  });
  assert.equal(plan.length, 4);
  assert.deepEqual(
    plan.map(({ command }) => command),
    [process.execPath, process.execPath, "/trusted/cargo", process.execPath],
  );
  assert.match(
    plan[0].args.join(" "),
    /packages[/\\]protocol[/\\]tsconfig\.json/,
  );
  assert.match(
    plan[1].args.join(" "),
    /packages[/\\]runtime[/\\]tsconfig\.json/,
  );
  assert.deepEqual(plan[2].args.slice(0, 2), ["run", "--locked"]);
  const outIndex = plan[2].args.indexOf("--out");
  const typesOutIndex = plan[2].args.indexOf("--types-out");
  assert.deepEqual(
    plan[2].args.slice(outIndex, outIndex + 2),
    ["--out", "/isolated/artifact"],
  );
  assert.deepEqual(
    plan[2].args.slice(typesOutIndex, typesOutIndex + 2),
    ["--types-out", "/isolated/types/routes.d.ts"],
  );
  assert.match(plan[3].args[0], /website[/\\]deploy-adapter\.mjs$/);
  assert.deepEqual(
    plan[3].args.slice(1),
    ["/isolated/artifact", "/isolated/dist"],
  );
  for (const step of plan) {
    assert.notEqual(step.command, "pnpm");
    assert.notEqual(step.command, "npm");
    assert.ok(step.timeoutMs > 0);
  }
});

test("Sites Rust bootstrap is pinned and platform-bounded", () => {
  assert.equal(RUST_TOOLCHAIN, "1.95.0");
  assert.equal(
    RUSTUP_INIT_URL,
    "https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init",
  );
  assert.equal(RUSTUP_TARGET, "x86_64-unknown-linux-gnu");
  assert.match(RUSTUP_INIT_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(ZIG_VERSION, "0.15.2");
  assert.equal(
    ZIG_ARCHIVE_URL,
    "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz",
  );
  assert.match(ZIG_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    ZIG_ARCHIVE_SHA256,
    "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
  );
  assert.equal(SYSTEM_TAR, "/usr/bin/tar");
  assert.equal(
    sha256(Buffer.from("ferrite")),
    "fe1df1cfd83d440767bd8fbad4b386567fd7ca103695878cac3b491228c63a51",
  );
  assert.equal(rustBootstrapSupported("linux", "x64"), true);
  assert.equal(rustBootstrapSupported("linux", "arm64"), false);
  assert.equal(rustBootstrapSupported("darwin", "x64"), false);
});

test("bounded rustup reader rejects an oversized stream", async () => {
  const bytes = Buffer.from("rustup");
  assert.deepEqual(
    await readBoundedBody(responseFor(bytes), 6),
    bytes,
  );
  await assert.rejects(
    readBoundedBody(responseFor(bytes, { contentLength: null }), 5),
    /exceeds the size limit/,
  );
});

test("verified download streams to disk with size and checksum bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-download-test-"));
  const bytes = Buffer.from("verified archive");
  try {
    const output = join(directory, "archive");
    assert.equal(
      await writeVerifiedBody(
        responseFor(bytes),
        output,
        sha256(bytes),
        bytes.length,
      ),
      bytes.length,
    );
    assert.deepEqual(await readFile(output), bytes);
    await assert.rejects(
      writeVerifiedBody(
        responseFor(bytes),
        join(directory, "oversized"),
        sha256(bytes),
        bytes.length - 1,
      ),
      /exceeds the size limit/,
    );
    await assert.rejects(
      writeVerifiedBody(
        responseFor(bytes),
        join(directory, "checksum"),
        "0".repeat(64),
        bytes.length,
      ),
      /checksum mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real XZ decoder streams bytes and enforces output destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-xz-test-"));
  const source = join(directory, "fixture.tar.xz");
  const expected = Buffer.from("verified tar bytes");
  const fixture = Buffer.from(
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQARdmVyaWZpZWQgdGFyIGJ5dGVzAAAAlewz/+DnDOIAASoSSwhUvB+2830BAAAAAARZWg==",
    "base64",
  );
  try {
    await writeFile(source, fixture);
    const output = join(directory, "fixture.tar");
    assert.equal(
      await decompressXzArchive(source, output, expected.length),
      expected.length,
    );
    assert.deepEqual(await readFile(output), expected);

    await assert.rejects(
      decompressXzArchive(
        source,
        join(directory, "oversized.tar"),
        expected.length - 1,
      ),
      /exceeds the expanded size limit/,
    );

    const existing = join(directory, "existing.tar");
    await writeFile(existing, "preserve");
    await assert.rejects(
      decompressXzArchive(source, existing, expected.length),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(existing, "utf8"), "preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("XZ decoder resolves native ESM and UMD module shapes", () => {
  class Constructor {}
  assert.equal(
    resolveXzReadableStream({ XzReadableStream: Constructor }),
    Constructor,
  );
  assert.equal(
    resolveXzReadableStream({
      default: { XzReadableStream: Constructor },
    }),
    Constructor,
  );
  assert.equal(
    resolveXzReadableStream({
      XzReadableStream: {},
      default: { XzReadableStream: Constructor },
    }),
    Constructor,
  );
  assert.throws(
    () => resolveXzReadableStream({ default: {} }),
    /does not expose the expected XzReadableStream constructor/,
  );
});

test("Zig linker install is pinned and produces a bounded cc wrapper", async () => {
  const payload = Buffer.from("zig archive");
  const events = [];
  const linker = await installZigLinker({
    toolRoot: "/repo/.ferrite/sites-rust-test",
    env: {
      PATH: "/repo/node_modules/.bin:/usr/bin",
      TAR_OPTIONS: "--checkpoint-action=exec=untrusted",
      XZ_DEFAULTS: "--threads=99",
      XZ_OPT: "--memlimit=99",
    },
    expectedSha256: sha256(payload),
    fetchImpl: async (url, options) => {
      events.push({ type: "fetch", url, options });
      return responseFor(payload, { url });
    },
    downloadImpl: async (response, destination, expected, maximum) => {
      events.push({
        type: "download",
        response,
        destination,
        expected,
        maximum,
      });
    },
    decompressImpl: async (source, destination, maximum) => {
      events.push({ type: "decompress", source, destination, maximum });
    },
    mkdirImpl: async (path, options) => {
      events.push({ type: "mkdir", path, options });
    },
    runImpl: async (command, args, env, timeoutMs) => {
      events.push({ type: "run", command, args, env, timeoutMs });
    },
    lstatImpl: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
    writeFileImpl: async (path, bytes, options) => {
      events.push({ type: "write", path, bytes, options });
    },
  });

  assert.equal(
    linker,
    "/repo/.ferrite/sites-rust-test/zig-cc.mjs",
  );
  const fetchEvent = events.find(({ type }) => type === "fetch");
  assert.equal(fetchEvent.url, ZIG_ARCHIVE_URL);
  assert.equal(fetchEvent.options.redirect, "error");
  const downloadEvent = events.find(({ type }) => type === "download");
  assert.equal(downloadEvent.expected, sha256(payload));
  assert.match(downloadEvent.destination, /zig-0\.15\.2\.tar\.xz$/);
  const decompressEvent = events.find(
    ({ type }) => type === "decompress",
  );
  assert.equal(decompressEvent.source, downloadEvent.destination);
  assert.match(decompressEvent.destination, /zig-0\.15\.2\.tar$/);
  assert.equal(decompressEvent.maximum, 1024 * 1024 * 1024);
  const runEvent = events.find(({ type }) => type === "run");
  assert.equal(runEvent.command, SYSTEM_TAR);
  assert.deepEqual(runEvent.args, [
    "-xf",
    decompressEvent.destination,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions",
    "-C",
    "/repo/.ferrite/sites-rust-test/zig",
  ]);
  assert.equal(
    runEvent.env.PATH,
    "/repo/node_modules/.bin:/usr/bin",
  );
  assert.equal(runEvent.env.TAR_OPTIONS, undefined);
  assert.equal(runEvent.env.XZ_DEFAULTS, undefined);
  assert.equal(runEvent.env.XZ_OPT, undefined);
  assert.ok(runEvent.timeoutMs > 0);
  const writeEvent = events.find(({ type }) => type === "write");
  assert.match(
    writeEvent.bytes,
    new RegExp(`^#!${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(writeEvent.bytes, /spawnSync/);
  assert.match(writeEvent.bytes, /\["cc"/);
  assert.equal(writeEvent.options.mode, 0o700);
});

test("Zig cc wrapper preserves linker arguments and exit status", async () => {
  const toolRoot = await mkdtemp(join(tmpdir(), "ferrite-zig-wrapper-"));
  const zigRoot = join(toolRoot, "zig");
  const argvOutput = join(toolRoot, "argv.json");
  try {
    const linker = await installZigLinker({
      toolRoot,
      env: { PATH: "/repo/node_modules/.bin:/usr/bin" },
      expectedSha256: sha256(Buffer.from("zig archive")),
      fetchImpl: async (url) =>
        responseFor(Buffer.from("zig archive"), { url }),
      downloadImpl: async () => {},
      decompressImpl: async () => {},
      runImpl: async () => {
        const fakeZig = join(zigRoot, "zig");
        await writeFile(
          fakeZig,
          `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.FERRITE_ZIG_ARGV_OUTPUT, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FERRITE_ZIG_EXIT));
`,
        );
        await chmod(fakeZig, 0o700);
      },
    });
    const result = spawnSync(
      process.execPath,
      [linker, "-Wl,--as-needed", "object.o"],
      {
        env: {
          ...process.env,
          FERRITE_ZIG_ARGV_OUTPUT: argvOutput,
          FERRITE_ZIG_EXIT: "23",
        },
      },
    );
    assert.equal(result.status, 23);
    assert.deepEqual(
      JSON.parse(await readFile(argvOutput, "utf8")),
      ["cc", "-Wl,--as-needed", "object.o"],
    );
  } finally {
    await rm(toolRoot, { recursive: true, force: true });
  }
});

test("pinned Rust bootstrap verifies payload, arguments, environment, and cleanup", async () => {
  const payload = Buffer.from("trusted rustup");
  const events = [];
  const removed = [];
  const result = await bootstrapCargo({
    platform: "linux",
    arch: "x64",
    sourceRoot: "/repo",
    env: {
      PATH: "/usr/bin",
      RUSTC_WRAPPER: "/untrusted/wrapper",
      RUSTUP_DIST_SERVER: "https://untrusted.example",
      RUSTUP_UPDATE_ROOT: "https://untrusted.example/rustup",
    },
    expectedSha256: sha256(payload),
    fetchImpl: async (url, options) => {
      events.push({ type: "fetch", url, options });
      return responseFor(payload, { url });
    },
    mkdirImpl: async (path, options) => {
      events.push({ type: "mkdir", path, options });
    },
    mkdtempImpl: async (prefix) => {
      events.push({ type: "mkdtemp", prefix });
      return "/repo/.ferrite/sites-rust-test";
    },
    writeFileImpl: async (path, bytes, options) => {
      events.push({ type: "write", path, bytes, options });
    },
    runImpl: async (command, args, env, timeoutMs) => {
      events.push({ type: "run", command, args, env, timeoutMs });
    },
    installLinkerImpl: async ({ toolRoot, env }) => {
      events.push({ type: "linker", toolRoot, env });
      return "/repo/.ferrite/sites-rust-test/zig-cc.mjs";
    },
    rmImpl: async (path, options) => {
      removed.push({ path, options });
    },
  });

  assert.equal(
    result.command,
    "/repo/.ferrite/sites-rust-test/cargo/bin/cargo",
  );
  assert.equal(events[0].path, "/repo/.ferrite");
  assert.equal(events[1].prefix, "/repo/.ferrite/sites-rust-");
  const fetchEvent = events.find(({ type }) => type === "fetch");
  assert.equal(fetchEvent.url, RUSTUP_INIT_URL);
  assert.equal(fetchEvent.options.redirect, "error");
  const writeEvent = events.find(({ type }) => type === "write");
  assert.deepEqual(writeEvent.bytes, payload);
  assert.equal(writeEvent.options.mode, 0o700);
  const runEvent = events.find(({ type }) => type === "run");
  assert.deepEqual(runEvent.args, [
    "-y",
    "--no-modify-path",
    "--profile",
    "minimal",
    "--default-host",
    RUSTUP_TARGET,
    "--default-toolchain",
    `${RUST_TOOLCHAIN}-${RUSTUP_TARGET}`,
  ]);
  assert.equal(runEvent.timeoutMs, 5 * 60_000);
  assert.equal(runEvent.env.RUSTUP_DIST_SERVER, "https://static.rust-lang.org");
  assert.equal(
    runEvent.env.RUSTUP_UPDATE_ROOT,
    "https://static.rust-lang.org/rustup",
  );
  assert.equal(runEvent.env.RUSTC_WRAPPER, undefined);
  assert.equal(
    result.env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER,
    "/repo/.ferrite/sites-rust-test/zig-cc.mjs",
  );
  assert.equal(removed.length, 0);
  await result.cleanup();
  await result.cleanup();
  assert.deepEqual(removed, [
    {
      path: "/repo/.ferrite/sites-rust-test",
      options: { recursive: true, force: true },
    },
  ]);
});

test("Rust bootstrap fails closed before execution and cleans scratch", async () => {
  let executions = 0;
  const removed = [];
  await assert.rejects(
    bootstrapCargo({
      platform: "linux",
      arch: "x64",
      sourceRoot: "/repo",
      expectedSha256: sha256(Buffer.from("expected")),
      fetchImpl: async () => responseFor(Buffer.from("different")),
      mkdirImpl: async () => {},
      mkdtempImpl: async () => "/repo/.ferrite/sites-rust-test",
      writeFileImpl: async () => {},
      runImpl: async () => {
        executions += 1;
      },
      rmImpl: async (path) => {
        removed.push(path);
      },
    }),
    /checksum mismatch/,
  );
  assert.equal(executions, 0);
  assert.deepEqual(removed, ["/repo/.ferrite/sites-rust-test"]);

  const linkerFailureRemovals = [];
  await assert.rejects(
    bootstrapCargo({
      platform: "linux",
      arch: "x64",
      sourceRoot: "/repo",
      expectedSha256: sha256(Buffer.from("trusted rustup")),
      fetchImpl: async (url) =>
        responseFor(Buffer.from("trusted rustup"), { url }),
      mkdirImpl: async () => {},
      mkdtempImpl: async () => "/repo/.ferrite/sites-rust-linker-failure",
      writeFileImpl: async () => {},
      runImpl: async () => {},
      installLinkerImpl: async () => {
        throw new Error("linker extraction failed");
      },
      rmImpl: async (path) => {
        linkerFailureRemovals.push(path);
      },
    }),
    /linker extraction failed/,
  );
  assert.deepEqual(linkerFailureRemovals, [
    "/repo/.ferrite/sites-rust-linker-failure",
  ]);

  await assert.rejects(
    bootstrapCargo({
      platform: "linux",
      arch: "x64",
      sourceRoot: "/repo",
      maximumBytes: 4,
      fetchImpl: async () =>
        responseFor(Buffer.from("oversized"), { contentLength: null }),
      mkdirImpl: async () => {},
      mkdtempImpl: async () => "/repo/.ferrite/sites-rust-oversized",
      rmImpl: async () => {},
    }),
    /exceeds the size limit/,
  );

  await assert.rejects(
    bootstrapCargo({
      platform: "linux",
      arch: "x64",
      sourceRoot: "/repo",
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      mkdirImpl: async () => {},
      mkdtempImpl: async () => "/repo/.ferrite/sites-rust-timeout",
      rmImpl: async () => {},
    }),
    /timed out/,
  );

  await assert.rejects(
    bootstrapCargo({
      platform: "darwin",
      arch: "arm64",
      mkdirImpl: async () => {
        throw new Error("must not allocate");
      },
    }),
    /supports only x86_64 Linux/,
  );
});

test("explicit bootstrap flag wins over ambient Cargo", async () => {
  let probed = false;
  let bootstrapped = false;
  const expected = {
    command: "/pinned/cargo",
    env: {},
    cleanup: async () => {},
  };
  const result = await resolveCargo({
    env: {
      CARGO: "/ambient/cargo",
      FERRITE_SITES_BOOTSTRAP_RUST: "1",
    },
    commandAvailableImpl: async () => {
      probed = true;
      return true;
    },
    bootstrapImpl: async () => {
      bootstrapped = true;
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(bootstrapped, true);
  assert.equal(probed, false);
  await assert.rejects(
    resolveCargo({
      env: { FERRITE_SITES_BOOTSTRAP_RUST: "sometimes" },
    }),
    /must be 0 or 1/,
  );
});

test("Sites source build cleans the pinned toolchain after downstream failure", async () => {
  let cleanups = 0;
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-build-fail-"));
  try {
    await assert.rejects(
      buildSitesSource({
        env: {},
        scratchParent: directory,
        resolveCargoImpl: async () => ({
          command: "/pinned/cargo",
          env: {},
          cleanup: async () => {
            cleanups += 1;
          },
        }),
        buildPlanImpl: () => [
          { command: "failure", args: [], timeoutMs: 1 },
        ],
        runImpl: async () => {
          throw new Error("downstream build failed");
        },
      }),
      /downstream build failed/,
    );
    assert.equal(cleanups, 1);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Sites source build isolates each artifact and packaged output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-build-"));
  const destination = join(directory, "destination");
  let planOptions;
  let sourceForReplacement;
  let toolchainCleanups = 0;
  try {
    const result = await buildSitesSource({
      env: {},
      scratchParent: join(directory, "scratch"),
      outputDist: destination,
      resolveCargoImpl: async () => ({
        command: "/pinned/cargo",
        env: {},
        cleanup: async () => {
          toolchainCleanups += 1;
        },
      }),
      buildPlanImpl: (_cargo, options) => {
        planOptions = options;
        return [{ command: "success", args: [], timeoutMs: 1 }];
      },
      runImpl: async () => {},
      requireDirectoryImpl: async () => {},
      replaceSiteOutputImpl: async (source, output) => {
        sourceForReplacement = source;
        assert.equal(output, destination);
      },
    });

    assert.equal(result.outputDist, destination);
    assert.equal(sourceForReplacement, planOptions.distDirectory);
    assert.equal(
      planOptions.artifactDirectory,
      join(
        planOptions.distDirectory,
        "..",
        "artifact",
      ),
    );
    assert.equal(
      planOptions.typesOutput,
      join(planOptions.distDirectory, "..", "types", "routes.d.ts"),
    );
    assert.equal(toolchainCleanups, 1);
    assert.deepEqual(await readdir(join(directory, "scratch")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement preserves npm release and CI evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-output-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const receipt = join(
    destination,
    "npm-packages",
    "npm-publication-receipt.json",
  );
  const tarball = join(
    destination,
    "npm-packages",
    "tarballs",
    "ferrite-runtime.tgz",
  );
  const ciReceipt = join(destination, "ci", "results.tsv");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    await mkdir(join(destination, "npm-packages", "tarballs"), {
      recursive: true,
    });
    await mkdir(join(destination, "ci"), { recursive: true });
    await writeFile(receipt, "immutable receipt");
    await writeFile(tarball, "immutable tarball");
    await writeFile(ciReceipt, "immutable CI evidence");
    const cliSentinel = join(destination, "cli", "ferrite");
    await mkdir(join(destination, "cli"), { recursive: true });
    await writeFile(cliSentinel, "immutable cli launcher");

    await replaceSiteOutput(source, destination);

    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `new:${name}`,
      );
    }
    assert.equal(await readFile(receipt, "utf8"), "immutable receipt");
    assert.equal(await readFile(tarball, "utf8"), "immutable tarball");
    assert.equal(await readFile(ciReceipt, "utf8"), "immutable CI evidence");
    assert.equal(await readFile(cliSentinel, "utf8"), "immutable cli launcher");
    assert.deepEqual(
      (await readdir(destination)).filter((name) => name.startsWith(".site-")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rolls back without touching release evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-rollback-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const receipt = join(
    destination,
    "npm-packages",
    "npm-publication-receipt.json",
  );
  const tarball = join(
    destination,
    "npm-packages",
    "tarballs",
    "ferrite-runtime.tgz",
  );
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    await mkdir(join(destination, "npm-packages", "tarballs"), {
      recursive: true,
    });
    await writeFile(receipt, "immutable receipt");
    await writeFile(tarball, "immutable tarball");
    const cliSentinel = join(destination, "cli", "ferrite");
    await mkdir(join(destination, "cli"), { recursive: true });
    await writeFile(cliSentinel, "immutable cli launcher");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        renameImpl: async (from, to) => {
          if (
            from.includes(".site-next-") &&
            from.endsWith(`${join("", "server")}`)
          ) {
            throw new Error("injected server install failure");
          }
          await rename(from, to);
        },
      }),
      /injected server install failure/,
    );

    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
    assert.equal(await readFile(receipt, "utf8"), "immutable receipt");
    assert.equal(await readFile(tarball, "utf8"), "immutable tarball");
    assert.equal(await readFile(cliSentinel, "utf8"), "immutable cli launcher");
    assert.equal(
      (await readdir(destination)).includes(SITE_OUTPUT_LOCK),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects unexpected source entries before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-shape-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const receipt = join(
    destination,
    "npm-packages",
    "npm-publication-receipt.json",
  );
  try {
    await writeSiteOutput(source, "new");
    await mkdir(join(source, "npm-packages"), { recursive: true });
    await mkdir(join(destination, "npm-packages"), { recursive: true });
    await writeFile(receipt, "immutable receipt");
    const cliSentinel = join(destination, "cli", "ferrite");
    await mkdir(join(destination, "cli"), { recursive: true });
    await writeFile(cliSentinel, "immutable cli launcher");

    await assert.rejects(
      replaceSiteOutput(source, destination),
      /must contain only/,
    );

    assert.equal(await readFile(receipt, "utf8"), "immutable receipt");
    assert.equal(await readFile(cliSentinel, "utf8"), "immutable cli launcher");
    assert.deepEqual((await readdir(destination)).sort(), ["cli", "npm-packages"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects nested symlinks before mutating destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-nested-symlink-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const outside = join(directory, "outside.txt");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    await writeFile(outside, "outside");
    await symlink(outside, join(source, "client", "outside.txt"));

    await assert.rejects(
      replaceSiteOutput(source, destination),
      /website dist snapshot must not contain symlinks/,
    );
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects special files before mutating destination", async (context) => {
  if (process.platform === "win32") {
    context.skip("mkfifo is unavailable on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-special-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const special = join(source, "server", "socket");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    const fifo = spawnSync("mkfifo", [special]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString() ?? "mkfifo failed");

    await assert.rejects(
      replaceSiteOutput(source, destination),
      /website dist snapshot must contain only directories and regular files/,
    );
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects canonical-root escape before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-canonical-escape-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    const sourceRoot = await realpath(source);
    const escaped = join(directory, "outside");
    await assert.rejects(
      replaceSiteOutput(source, destination, {
        realpathImpl: async (path) =>
          path === join(sourceRoot, "client") ? escaped : realpath(path),
      }),
      /website dist snapshot escaped its canonical root/,
    );
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects a symlink destination without outside mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-symlink-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  const outside = join(directory, "outside");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(outside, "outside");
    await symlink(outside, destination, "dir");

    await assert.rejects(
      replaceSiteOutput(source, destination),
      /destination must be a non-symlink directory/,
    );

    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(outside, name, "marker.txt"), "utf8"),
        `outside:${name}`,
      );
    }
    assert.equal(
      (await readdir(outside)).some((name) => name.startsWith(".site-")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement serializes concurrent transactions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-lock-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  let releaseCopy;
  const copyGate = new Promise((resolve) => {
    releaseCopy = resolve;
  });
  let firstCopyStarted;
  const copyStarted = new Promise((resolve) => {
    firstCopyStarted = resolve;
  });
  let held = false;
  let firstFailure;
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    const first = replaceSiteOutput(source, destination, {
      cpImpl: async (...args) => {
        if (!held) {
          held = true;
          firstCopyStarted();
          await copyGate;
        }
        await cp(...args);
      },
    });
    first.catch((error) => {
      firstFailure = error;
      firstCopyStarted();
    });
    await copyStarted;
    if (firstFailure) throw firstFailure;

    await assert.rejects(
      replaceSiteOutput(source, destination),
      /transaction lock exists.*preserve and reconcile/,
    );

    releaseCopy();
    await first;
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `new:${name}`,
      );
    }
    assert.equal(
      (await readdir(destination)).includes(SITE_OUTPUT_LOCK),
      false,
    );
  } finally {
    releaseCopy?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects source drift before activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-source-drift-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  let copies = 0;
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        cpImpl: async (...args) => {
          await cp(...args);
          copies += 1;
          if (copies === 1) {
            await writeFile(
              join(source, "client", "marker.txt"),
              "old:client",
            );
          }
        },
      }),
      /website dist changed during site output snapshot/,
    );

    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
    assert.equal(
      (await readdir(destination)).includes(SITE_OUTPUT_LOCK),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement rejects a corrupted staged copy before activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-copy-drift-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        cpImpl: async (from, to, options) => {
          await cp(from, to, options);
          if (from === join(source, "client")) {
            await writeFile(join(to, "marker.txt"), "corrupt:client");
          }
        },
      }),
      /website dist changed during site output snapshot/,
    );

    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
    assert.equal(
      (await readdir(destination)).includes(SITE_OUTPUT_LOCK),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement cleans an allocated staging directory when backup allocation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-allocate-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  let allocations = 0;
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        mkdtempImpl: async (prefix) => {
          allocations += 1;
          if (allocations === 2) {
            throw new Error("injected backup allocation failure");
          }
          return await mkdtemp(prefix);
        },
      }),
      /injected backup allocation failure/,
    );

    assert.equal(
      (await readdir(destination)).some((name) => name.startsWith(".site-")),
      false,
    );
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement retains lock and backup after incomplete rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-rollback-lock-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        renameImpl: async (from, to) => {
          if (
            from.includes(".site-next-") &&
            from.endsWith("server")
          ) {
            throw new Error("injected install failure");
          }
          if (
            from.includes(".site-backup-") &&
            from.endsWith("client")
          ) {
            throw new Error("injected rollback failure");
          }
          await rename(from, to);
        },
      }),
      /preserve .*site-build-lock.*remaining scratch/,
    );

    const names = await readdir(destination);
    assert.ok(names.includes(SITE_OUTPUT_LOCK));
    const backup = names.find((name) => name.startsWith(".site-backup-"));
    assert.ok(backup);
    assert.equal(
      await readFile(join(destination, backup, "client", "marker.txt"), "utf8"),
      "old:client",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement retains the lock on scratch cleanup failure", async (context) => {
  for (const failingPrefix of [".site-backup-", ".site-next-"]) {
    await context.test(failingPrefix, async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "ferrite-site-cleanup-lock-"),
      );
      const source = join(directory, "source");
      const destination = join(directory, "dist");
      try {
        await writeSiteOutput(source, "new");
        await writeSiteOutput(destination, "old");

        await assert.rejects(
          replaceSiteOutput(source, destination, {
            rmImpl: async (path, options) => {
              if (path.includes(failingPrefix)) {
                throw new Error(`injected ${failingPrefix} cleanup failure`);
              }
              await rm(path, options);
            },
          }),
          /preserve .*site-build-lock.*remaining scratch/,
        );

        const names = await readdir(destination);
        assert.ok(names.includes(SITE_OUTPUT_LOCK));
        assert.ok(names.some((name) => name.startsWith(failingPrefix)));
        for (const name of SITE_OUTPUT_ENTRIES) {
          assert.equal(
            await readFile(join(destination, name, "marker.txt"), "utf8"),
            `new:${name}`,
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("site output replacement reports lock removal failure without hiding installed output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-unlock-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");

    await assert.rejects(
      replaceSiteOutput(source, destination, {
        rmImpl: async (path, options) => {
          if (path.endsWith(SITE_OUTPUT_LOCK)) {
            throw new Error("injected lock removal failure");
          }
          await rm(path, options);
        },
      }),
      /preserve .*site-build-lock.*remaining scratch/,
    );

    assert.ok((await readdir(destination)).includes(SITE_OUTPUT_LOCK));
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `new:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("site output replacement aggregates operation and cleanup failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-site-error-aggregate-"));
  const source = join(directory, "source");
  const destination = join(directory, "dist");
  try {
    await writeSiteOutput(source, "new");
    await writeSiteOutput(destination, "old");
    await assert.rejects(
      replaceSiteOutput(source, destination, {
        renameImpl: async (from, to) => {
          if (from.includes(".site-next-") && from.endsWith("server")) {
            throw new Error("injected operation failure");
          }
          await rename(from, to);
        },
        rmImpl: async (path, options) => {
          if (path.includes(".site-next-")) {
            throw new Error("injected cleanup failure");
          }
          await rm(path, options);
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map(({ message }) => message),
          ["injected operation failure", "injected cleanup failure"],
        );
        assert.match(error.message, /preserve .*site-build-lock.*remaining scratch/);
        return true;
      },
    );
    const names = await readdir(destination);
    assert.ok(names.includes(SITE_OUTPUT_LOCK));
    assert.ok(names.some((name) => name.startsWith(".site-next-")));
    for (const name of SITE_OUTPUT_ENTRIES) {
      assert.equal(
        await readFile(join(destination, name, "marker.txt"), "utf8"),
        `old:${name}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run timeout terminates the owned descendant process group", {
  skip: process.platform === "win32" ? "process groups are not supported" : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ferrite-run-timeout-"));
  const marker = join(directory, "descendant-survived");
  const groupFile = join(directory, "owned-process-group");
  const parentScript = join(directory, "parent.mjs");
  try {
    await writeFile(
      parentScript,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.FERRITE_TIMEOUT_GROUP, String(process.pid));",
        "spawn(process.execPath, [",
        '  "-e",',
        '  "process.on(\'SIGTERM\', () => {}); setTimeout(() => require(\'node:fs\').writeFileSync(process.env.FERRITE_TIMEOUT_MARKER, \'survived\'), 2000); setInterval(() => {}, 1000);",',
        "], { env: process.env, stdio: \"ignore\" });",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await assert.rejects(
      run(
        process.execPath,
        [parentScript],
        {
          ...process.env,
          FERRITE_TIMEOUT_GROUP: groupFile,
          FERRITE_TIMEOUT_MARKER: marker,
        },
        500,
        50,
      ),
      /timed out after 500ms/,
    );
    const ownedGroup = Number(await readFile(groupFile, "utf8"));
    assert.ok(Number.isSafeInteger(ownedGroup) && ownedGroup > 0);
    assert.throws(
      () => process.kill(-ownedGroup, 0),
      (error) => error?.code === "ESRCH",
    );
    await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
