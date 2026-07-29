import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCliCandidate as createCliCandidateImpl,
  verifyCliCandidate,
} from "../scripts/create-cli-candidate.mjs";

function createCliCandidate(options) {
  const { renameImpl, ...candidateOptions } = options;
  return createCliCandidateImpl({
    publishDirectoryImpl: renameImpl ?? rename,
    ...candidateOptions,
  });
}

test("createCliCandidate emits a verified current-host package pair", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "output with spaces", "candidate");
    const result = await createCliCandidate({
      binaryPath: binary,
      destinationRoot: destination,
    });
    const verified = await verifyCliCandidate(destination);

    assert.equal(result.root, destination);
    assert.equal(result.platformPackage, "@ferrite/cli-darwin-arm64");
    assert.equal(verified.packageVersion, "0.1.0-alpha.0");
    assert.equal(verified.bytes, Buffer.byteLength(fakeBinary));
    assert.match(verified.sha256, /^[a-f0-9]{64}$/);

    const wrapper = JSON.parse(
      await readFile(join(destination, "cli", "package.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(wrapper, "private"), false);
    assert.equal(Object.hasOwn(wrapper, "scripts"), false);
    assert.deepEqual(wrapper.optionalDependencies, {
      "@ferrite/cli-darwin-arm64": "0.1.0-alpha.0",
    });
  });
});

test("createCliCandidate rejects absent, non-executable, and symbolic-link binaries", async () => {
  await usingFixture(async ({ binary, root }) => {
    await assert.rejects(
      createCliCandidate({
        binaryPath: join(root, "missing"),
        destinationRoot: join(root, "missing-output"),
      }),
      /was not found/,
    );

    await chmod(binary, 0o644);
    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: join(root, "non-executable-output"),
      }),
      /must be executable/,
    );

    await chmod(binary, 0o755);
    const link = join(root, "ferrite-link");
    await symlink(binary, link);
    await assert.rejects(
      createCliCandidate({
        binaryPath: link,
        destinationRoot: join(root, "link-output"),
      }),
      /non-symbolic-link file/,
    );
  });
});

test("createCliCandidate rejects unverified platforms before writing output", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "linux-output");
    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        platform: "linux",
        arch: "x64",
      }),
      /No verified Ferrite CLI npm target/,
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

test("createCliCandidate rejects CLI and runtime package version drift", async () => {
  await usingFixture(async ({ binary, root }) => {
    const runtimeManifest = join(root, "runtime-package.json");
    await writeFile(
      runtimeManifest,
      `${JSON.stringify({
        name: "@ferrite/runtime",
        version: "0.1.0-alpha.1",
      })}\n`,
    );
    const destination = join(root, "version-drift-output");

    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        runtimeManifestPath: runtimeManifest,
      }),
      /requires a matching @ferrite\/runtime source version/,
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

test("verifyCliCandidate rejects a modified packaged binary", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    const result = await createCliCandidate({
      binaryPath: binary,
      destinationRoot: destination,
    });
    await writeFile(join(result.platformDirectory, "bin", "ferrite"), "tampered");
    await assert.rejects(
      verifyCliCandidate(destination),
      /(binary size mismatch|checksum mismatch)/,
    );
  });
});

test("verifyCliCandidate rejects lifecycle scripts and broken platform exports", async () => {
  await usingFixture(async ({ binary, root }) => {
    const lifecycleDestination = join(root, "lifecycle-candidate");
    await createCliCandidate({
      binaryPath: binary,
      destinationRoot: lifecycleDestination,
    });
    const wrapperManifestPath = join(
      lifecycleDestination,
      "cli",
      "package.json",
    );
    const wrapperManifest = JSON.parse(
      await readFile(wrapperManifestPath, "utf8"),
    );
    wrapperManifest.scripts = { postinstall: "node download-binary.js" };
    await writeFile(
      wrapperManifestPath,
      `${JSON.stringify(wrapperManifest, null, 2)}\n`,
    );
    await assert.rejects(
      verifyCliCandidate(lifecycleDestination),
      /must not contain scripts or non-optional dependencies/,
    );

    const exportsDestination = join(root, "exports-candidate");
    await createCliCandidate({
      binaryPath: binary,
      destinationRoot: exportsDestination,
    });
    const platformManifestPath = join(
      exportsDestination,
      "cli-darwin-arm64",
      "package.json",
    );
    const platformManifest = JSON.parse(
      await readFile(platformManifestPath, "utf8"),
    );
    delete platformManifest.exports["./bin/ferrite"];
    await writeFile(
      platformManifestPath,
      `${JSON.stringify(platformManifest, null, 2)}\n`,
    );
    await assert.rejects(
      verifyCliCandidate(exportsDestination),
      /platform manifest does not match/,
    );
  });
});

test("createCliCandidate restores prior output when publication fails", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    await createCliCandidate({ binaryPath: binary, destinationRoot: destination });
    const priorChecksum = await readFile(
      join(
        destination,
        "cli-darwin-arm64",
        "ferrite-cli.sha256.json",
      ),
      "utf8",
    );

    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        async renameImpl(source, target) {
          if (source.includes(".staging-") && target.endsWith("/candidate")) {
            throw new Error("injected publication failure");
          }
          return rename(source, target);
        },
      }),
      /injected publication failure/,
    );

    assert.equal(
      await readFile(
        join(
          destination,
          "cli-darwin-arm64",
          "ferrite-cli.sha256.json",
        ),
        "utf8",
      ),
      priorChecksum,
    );
    await verifyCliCandidate(destination);
    const residue = (await readdir(root)).filter(
      (name) => name.includes(".staging-") || name.includes(".backup-"),
    );
    assert.deepEqual(residue, []);
  });
});

test("createCliCandidate preserves a verified backup when rollback fails", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    await createCliCandidate({ binaryPath: binary, destinationRoot: destination });

    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        async renameImpl(source, target) {
          if (source.includes(".staging-") && target.endsWith("/candidate")) {
            throw new Error("injected publication failure");
          }
          if (source.includes(".backup-") && target.endsWith("/candidate")) {
            throw new Error("injected rollback failure");
          }
          return rename(source, target);
        },
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => /publication failure/.test(entry.message)) &&
        error.errors.some((entry) => /rollback failure/.test(entry.message)),
    );

    await assert.rejects(lstat(destination), { code: "ENOENT" });
    const backups = (await readdir(root)).filter((name) =>
      name.includes(".backup-"),
    );
    assert.equal(backups.length, 1);
    await verifyCliCandidate(join(root, backups[0]));
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".staging-")),
      [],
    );
  });
});

test("createCliCandidate preserves both verified outputs when backup cleanup fails", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    await createCliCandidate({ binaryPath: binary, destinationRoot: destination });

    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        async removeImpl(path, options) {
          if (path.includes(".backup-")) {
            throw new Error("injected backup cleanup failure");
          }
          return rm(path, options);
        },
      }),
      /published.*prior output remains.*backup cleanup failure/,
    );

    await verifyCliCandidate(destination);
    const backups = (await readdir(root)).filter((name) =>
      name.includes(".backup-"),
    );
    assert.equal(backups.length, 1);
    await verifyCliCandidate(join(root, backups[0]));
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".staging-")),
      [],
    );
  });
});

test("createCliCandidate preserves an unrelated existing destination", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "owned-directory");
    await mkdir(destination, { recursive: true });
    const marker = join(destination, "owned.txt");
    await writeFile(marker, "keep\n");

    await assert.rejects(
      createCliCandidate({ binaryPath: binary, destinationRoot: destination }),
      /Refusing to replace an unverified CLI candidate/,
    );
    assert.equal(await readFile(marker, "utf8"), "keep\n");
  });
});

test("createCliCandidate removes private staging after a write failure", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    let writes = 0;
    await assert.rejects(
      createCliCandidate({
        binaryPath: binary,
        destinationRoot: destination,
        async writeFileImpl(path, bytes, options) {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          return writeFile(path, bytes, options);
        },
      }),
      /injected write failure/,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.includes(".staging-")),
      [],
    );
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

const fakeBinary = "#!/bin/sh\nprintf 'ferrite 0.1.0\\n'\n";

async function usingFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "ferrite cli candidate "));
  const binary = join(root, "ferrite");
  await writeFile(binary, fakeBinary, { mode: 0o755 });
  try {
    await callback({ binary, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
