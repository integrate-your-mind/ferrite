import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    if (command.endsWith("ferrite")) {
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
test("cleans a newly created target after install failure", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock({ failInstall: true }) }),
    /injected install failure/,
  );
  await assert.rejects(() => stat(target), { code: "ENOENT" });
});

test("restores an existing empty target after install failure", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  await mkdir(target);

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand: commandMock({ failInstall: true }) }),
    /injected install failure/,
  );
  assert.deepEqual(await readdir(target), []);
});

test("does not delete an unexpected file created during a failed setup", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "app");
  const runCommand = async (command, args, options) => {
    if (command === "npm" && args[0] === "install") {
      await writeFile(join(options.cwd, "external.txt"), "preserve me");
      throw new Error("injected install failure");
    }
    return commandMock()(command, args, options);
  };

  await assert.rejects(
    () => createSourceStarter({ target, packages: f.packages, cliSource: f.cli, runCommand }),
    /injected install failure/,
  );
  assert.equal(await readFile(join(target, "external.txt"), "utf8"), "preserve me");
});
