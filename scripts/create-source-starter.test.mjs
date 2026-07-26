import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceStarter, parseStarterArgs } from "./create-source-starter.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ferrite-starter-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "ferrite");
  await writeFile(cli, "#!/bin/sh\n");
  await chmod(cli, 0o755);
  const protocol = join(root, "protocol.tgz");
  const runtime = join(root, "runtime.tgz");
  await writeFile(protocol, "protocol");
  await writeFile(runtime, "runtime");
  const packages = [
    { name: "@ferrite/protocol", tarballPath: protocol },
    { name: "@ferrite/runtime", tarballPath: runtime },
  ];
  return { root, cli, packages };
}
function commandMock({ failInstall = false } = {}) {
  return async (command, args) => {
    if (command.endsWith("ferrite") && args[0] === "init") {
      await mkdir(args[1], { recursive: true });
      await writeFile(
        join(args[1], "package.json"),
        JSON.stringify({
          scripts: { check: "ferrite check", dev: "ferrite dev" },
          dependencies: { "@ferrite/runtime": "0.1.0" },
        }),
      );
      await writeFile(join(args[1], ".gitignore"), "node_modules/\n");
    }
    if (command.endsWith("ferrite") && args[0] === "internal-publish-dir") {
      try {
        await lstat(args[2]);
        throw new Error(`starter target appeared during creation: ${args[2]}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rename(args[1], args[2]);
    }
    if (command === "npm" && args[0] === "install" && failInstall) {
      throw new Error("injected install failure");
    }
  };
}

test("accepts pnpm's separator and rejects ambiguous targets", () => {
  assert.equal(parseStarterArgs(["--", "/tmp/app"]), "/tmp/app");
  assert.equal(parseStarterArgs(["app"]), "app");
  assert.throws(() => parseStarterArgs([]), /usage:/);
  assert.throws(() => parseStarterArgs(["one", "two"]), /usage:/);
});

test("README keeps the unavailable registry skeleton out of the onboarding flow", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const rawInitializerStart = readme.indexOf("A locally built `ferrite` binary");
  const productionBoundaryStart = readme.indexOf("## Production boundary");

  assert.notEqual(rawInitializerStart, -1);
  assert.ok(productionBoundaryStart > rawInitializerStart);
  assert.match(readme, /pnpm starter:create -- \.\.\/my-ferrite-app/);
  const rawInitializerSection = readme.slice(rawInitializerStart, productionBoundaryStart);
  const shellBlocks = [...rawInitializerSection.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)]
    .map((match) => match[1]);
  assert.ok(shellBlocks.some((block) => /\bferrite init\b/.test(block)));
  assert.ok(shellBlocks.every((block) => !(/\bferrite init\b/.test(block) && /\bnpm install\b/.test(block))));
  assert.match(rawInitializerSection, /registry `404`/);
});

test("creates starter, rewrites package scripts/dependencies, and copies sources", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock() });
  const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  assert.equal(manifest.dependencies["@ferrite/protocol"], "file:.ferrite-source/packages/protocol.tgz");
  assert.equal(manifest.dependencies["@ferrite/runtime"], "file:.ferrite-source/packages/runtime.tgz");
  assert.match(manifest.scripts.check, /run-ferrite\.mjs/);
  assert.match(await readFile(join(target, ".gitignore"), "utf8"), /\.ferrite-source\//);
});
test("fails before mutation when required tarball is missing", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await assert.rejects(
    () => createSourceStarter({ target, packages: [f.packages[0]], cliSource: f.cli, runCommand: commandMock() }),
    /missing required tarball/,
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.root)).filter((entry) => entry.startsWith(".app.ferrite-starter-")), []);
});
test("refuses non-empty target without changing it", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await mkdir(target);
  await writeFile(join(target, "keep"), "yes");
  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock() }),
    /non-empty/,
  );
  assert.equal(await readFile(join(target, "keep"), "utf8"), "yes");
});

test("refuses an initial symlink target without mutating its victim", async (t) => {
  const f = await fixture(t);
  const victim = join(f.root, "victim");
  const target = join(f.root, "app");
  await mkdir(victim);
  await symlink(victim, target, "dir");

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock() }),
  );
  assert.deepEqual(await readdir(victim), []);
  assert.equal((await lstat(target)).isSymbolicLink(), true);
});
test("cleans a newly created target after install failure", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock({ failInstall: true }) }),
    /injected install failure/,
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
});

test("refuses an existing empty target before setup and preserves its identity", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await mkdir(target);
  const initial = await lstat(target);
  let commandCalled = false;

  await assert.rejects(
    () =>
      createSourceStarter({
        target,
        packages: f.packages,
        cliSource: f.cli,
        runCommand: async () => {
          commandCalled = true;
        },
      }),
    /existing directory.*absent target/,
  );
  assert.deepEqual(await readdir(target), []);
  const final = await lstat(target);
  assert.equal(final.dev, initial.dev);
  assert.equal(final.ino, initial.ino);
  assert.equal(commandCalled, false);
});

test("cleans unexpected files created inside private staging after failed setup", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  const runCommand = async (command, args, options) => {
    if (command === "npm" && args[0] === "run" && args[1] === "check") {
      await writeFile(join(options.cwd, "external.txt"), "preserve me");
      throw new Error("injected install failure");
    }
    return commandMock()(command, args, options);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /injected install failure/,
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
  assert.deepEqual((await readdir(f.root)).filter((entry) => entry.startsWith(".app.ferrite-starter-")), []);
});

test("preserves a target/package.json created concurrently during failing init", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  const runCommand = async (command, args) => {
    if (command.endsWith("ferrite") && args[0] === "init") {
      await mkdir(target);
      await writeFile(join(target, "package.json"), '{"created":"concurrently"}\n');
      throw new Error("injected init failure");
    }
    return commandMock()(command, args);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /injected init failure/,
  );
  assert.equal(await readFile(join(target, "package.json"), "utf8"), '{"created":"concurrently"}\n');
});

test("does not delete a victim when an accepted target is swapped to a symlink during failure", async (t) => {
  const f = await fixture(t);
  const victim = join(f.root, "victim");
  const target = join(f.root, "app");
  await mkdir(victim);
  await writeFile(join(victim, "keep"), "safe");
  const runCommand = async (command, args) => {
    if (command.endsWith("ferrite") && args[0] === "init") {
      await rm(target, { recursive: true, force: true });
      await symlink(victim, target, "dir");
      throw new Error("injected init failure");
    }
    return commandMock()(command, args);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /injected init failure/,
  );
  assert.equal(await readFile(join(victim, "keep"), "utf8"), "safe");
  assert.equal((await lstat(target)).isSymbolicLink(), true);
});

test("publishes into an absent target", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock() });
  assert.equal((await stat(target)).isDirectory(), true);
  assert.equal((await stat(join(target, "package.json"))).isFile(), true);
});

test("does not replace an empty target that appears during exclusive publication", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  let concurrentIdentity;
  const runCommand = async (command, args, options) => {
    if (command.endsWith("ferrite") && args[0] === "internal-publish-dir") {
      await mkdir(target);
      concurrentIdentity = await lstat(target);
    }
    return commandMock()(command, args, options);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /target appeared/,
  );
  const finalIdentity = await lstat(target);
  assert.equal(finalIdentity.dev, concurrentIdentity.dev);
  assert.equal(finalIdentity.ino, concurrentIdentity.ino);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual((await readdir(f.root)).filter((entry) => entry.startsWith(".app.ferrite-starter-")), []);
});

test("fails final publish when target becomes non-empty and preserves the concurrent file", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  const runCommand = async (command, args) => {
    if (command === "npm" && args[0] === "install") {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "concurrent.txt"), "preserve before publish");
    }
    return commandMock()(command, args);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /non-empty|concurrent|target/i,
  );
  assert.equal(await readFile(join(target, "concurrent.txt"), "utf8"), "preserve before publish");
});
