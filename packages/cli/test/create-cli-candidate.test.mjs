import assert from "node:assert/strict";
import {
  chmod,
  lstat,
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
  createCliCandidate,
  verifyCliCandidate,
} from "../scripts/create-cli-candidate.mjs";

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

test("createCliCandidate restores prior output when publication fails", async () => {
  await usingFixture(async ({ binary, root }) => {
    const destination = join(root, "candidate");
    await createCliCandidate({ binaryPath: binary, destinationRoot: destination });
    const marker = join(destination, "owned-marker");
    await writeFile(marker, "keep\n");

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

    assert.equal(await readFile(marker, "utf8"), "keep\n");
    const residue = (await readdir(root)).filter(
      (name) => name.includes(".staging-") || name.includes(".backup-"),
    );
    assert.deepEqual(residue, []);
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
