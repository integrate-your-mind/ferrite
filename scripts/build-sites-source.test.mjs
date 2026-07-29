import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapCargo,
  buildPlan,
  buildSitesSource,
  DEFAULT_SITE_ORIGIN,
  readBoundedBody,
  resolveCargo,
  RUST_TOOLCHAIN,
  RUSTUP_INIT_SHA256,
  RUSTUP_INIT_URL,
  RUSTUP_TARGET,
  rustBootstrapSupported,
  sha256,
  siteOrigin,
} from "./build-sites-source.mjs";

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
  const plan = buildPlan("/trusted/cargo");
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
  assert.match(plan[3].args[0], /website[/\\]deploy-adapter\.mjs$/);
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
  await assert.rejects(
    buildSitesSource({
      env: {},
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
});
