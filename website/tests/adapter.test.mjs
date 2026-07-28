import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  atomicReplaceDirectory,
  computeManifestBuildId,
  createSiteServer,
  packageArtifact,
} from "../deploy-adapter.mjs";

const bundle = {
  script: "/_ferrite/static/route.js",
  styles: [],
  outputs: ["route.js"],
  sourcemaps: [],
  assets: [],
  clientReferences: [],
  moduleGraph: [],
  inputSnapshot: [],
};

const fixtureFiles = {
  "index.html": "<h1>Home</h1>",
  "docs/index.html": "<h1>Docs</h1>",
  "assets/app.0123456789.js": "console.log('asset');",
  "_ferrite/static/route.js": "console.log('route');",
  "logo.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
  "blob.bin": "binary",
  "robots.txt": "# generated template\n",
  "sitemap.xml": "<!-- generated template -->\n",
  "server/home.mjs": "export default {};",
  "server/docs.mjs": "export default {};",
};

function fileRecords(files) {
  return Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, body]) => {
      const bytes = Buffer.from(body);
      return { path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
}

function validManifest(files) {
  const manifest = {
    format: { name: "ferrite-server", major: 1, minor: 0 },
    buildId: "",
    clientPublicPath: "/_ferrite/static",
    hasDocument: true,
    routes: [
      {
        path: "/",
        params: [],
        serverModule: "server/home.mjs",
        clientBundle: structuredClone(bundle),
        prerendered: { "/": "index.html" },
        observedActions: [],
      },
      {
        path: "/docs",
        params: [],
        serverModule: "server/docs.mjs",
        clientBundle: structuredClone(bundle),
        prerendered: { "/docs": "docs/index.html" },
        observedActions: [],
      },
    ],
    files: fileRecords(files),
    publicFiles: ["assets/app.0123456789.js", "blob.bin", "logo.svg", "robots.txt", "sitemap.xml"].filter((path) => Object.hasOwn(files, path)),
  };
  manifest.buildId = computeManifestBuildId(manifest);
  return manifest;
}

async function writeFixture(root, { files = fixtureFiles, manifest = validManifest(files), extra = [] } = {}) {
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  for (const relative of extra) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "undeclared");
  }
  await writeFile(join(root, "ferrite-server.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, "ferrite-build.json"), "{}\n");
}

async function request(server, path, options) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, options);
  return { response, body: await response.text() };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("packages verified prerendered routes/assets and serves deep links without a home fallback", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-adapter-fixture-"));
  const dist = join(fixture, "dist");
  try {
    await writeFixture(join(fixture, "artifact"));
    const result = await packageArtifact(join(fixture, "artifact"), dist, { siteOrigin: "https://one.example.test" });
    assert.equal(await readFile(join(result.dist, "client", "docs/index.html"), "utf8"), "<h1>Docs</h1>");
    for (const relative of ["index.html", "docs/index.html", "assets/app.0123456789.js", "logo.svg", "robots.txt", "sitemap.xml"]) assert.ok((await readFile(join(result.dist, "client", relative), "utf8")).length > 0, relative);
    await assert.rejects(readFile(join(result.dist, "client", "server/home.mjs")));
    assert.equal(JSON.parse(await readFile(join(result.dist, "server", "source-build.json"), "utf8")).siteOrigin, "https://one.example.test");
    assert.match(await readFile(join(result.dist, "client", "robots.txt"), "utf8"), /https:\/\/one\.example\.test\/sitemap\.xml/);
    assert.match(await readFile(join(result.dist, "client", "sitemap.xml"), "utf8"), /https:\/\/one\.example\.test\/docs/);

    const server = createSiteServer(dist).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const home = await request(server, "/");
      assert.equal(home.response.status, 200);
      assert.equal(home.body, "<h1>Home</h1>");
      const docs = await request(server, "/docs");
      assert.equal(docs.response.status, 200);
      assert.equal(docs.body, "<h1>Docs</h1>");
      assert.equal(docs.response.headers.get("content-type"), "text/html; charset=utf-8");
      const docsHead = await request(server, "/docs", { method: "HEAD" });
      assert.equal(docsHead.response.status, 200);
      assert.equal(docsHead.body, "");
      assert.equal(docsHead.response.headers.get("content-type"), "text/html; charset=utf-8");
      const rejectedPost = await request(server, "/docs", { method: "POST", body: "x".repeat(64 * 1024) });
      assert.equal(rejectedPost.response.status, 405);
      assert.equal(rejectedPost.response.headers.get("allow"), "GET, HEAD");
      assert.equal(rejectedPost.response.headers.get("cache-control"), "no-store");
      assert.equal(rejectedPost.body, "Method not allowed");
      const rejectedOptions = await request(server, "/docs", { method: "OPTIONS" });
      assert.equal(rejectedOptions.response.status, 405);
      assert.equal(rejectedOptions.response.headers.get("allow"), "GET, HEAD");
      assert.equal(rejectedOptions.body, "Method not allowed");
      const docsAfterRejectedBody = await request(server, "/docs");
      assert.equal(docsAfterRejectedBody.response.status, 200);
      assert.equal(docsAfterRejectedBody.body, "<h1>Docs</h1>");
      const asset = await request(server, "/assets/app.0123456789.js");
      assert.equal(asset.response.status, 200);
      assert.equal(asset.response.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(asset.response.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(asset.response.headers.get("x-content-type-options"), "nosniff");
      const binary = await request(server, "/blob.bin");
      assert.equal(binary.response.status, 200);
      assert.equal(binary.response.headers.get("content-type"), "application/octet-stream");
      const missing = await request(server, "/docs/not-a-route");
      assert.equal(missing.response.status, 404);
      assert.equal(missing.response.headers.get("cache-control"), "no-store");
      const undeclared = join(dist, "client", "secret.txt");
      await writeFile(undeclared, "must not be served");
      assert.equal((await request(server, "/secret.txt")).response.status, 404);
      const malformed = await request(server, "/%E0%A4%A");
      assert.equal(malformed.response.status, 400);
      assert.equal(malformed.body, "Bad request");
    } finally {
      await close(server);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("packages validated site public files when the Ferrite artifact does not enumerate them", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-public-files-fixture-"));
  try {
    const artifactFiles = Object.fromEntries(Object.entries(fixtureFiles).filter(([path]) => !["logo.svg", "blob.bin", "robots.txt", "sitemap.xml"].includes(path)));
    await writeFixture(join(fixture, "artifact"), { files: artifactFiles });
    const publicDirectory = join(fixture, "public");
    await mkdir(publicDirectory);
    await writeFile(join(publicDirectory, "logo.svg"), fixtureFiles["logo.svg"]);
    await writeFile(join(publicDirectory, "blob.bin"), fixtureFiles["blob.bin"]);
    await writeFile(join(publicDirectory, "robots.txt"), "source template\n");
    await writeFile(join(publicDirectory, "sitemap.xml"), "source template\n");

    const result = await packageArtifact(join(fixture, "artifact"), join(fixture, "dist"), {
      publicDirectory,
      siteOrigin: "https://public.example.test",
    });
    assert.ok(result.manifest.publicFiles.includes("logo.svg"));
    assert.ok(result.manifest.publicFiles.includes("robots.txt"));
    assert.equal(await readFile(join(result.client, "logo.svg"), "utf8"), fixtureFiles["logo.svg"]);
    assert.match(await readFile(join(result.client, "robots.txt"), "utf8"), /https:\/\/public\.example\.test\/sitemap\.xml/);
    assert.doesNotMatch(await readFile(join(result.client, "robots.txt"), "utf8"), /source template/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("origin drift regenerates metadata while retaining the verified source artifact identity", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-origin-fixture-"));
  try {
    await writeFixture(join(fixture, "artifact"));
    const first = await packageArtifact(join(fixture, "artifact"), join(fixture, "dist-one"), { siteOrigin: "https://one.example.test" });
    const second = await packageArtifact(join(fixture, "artifact"), join(fixture, "dist-two"), { siteOrigin: "https://two.example.test" });
    assert.equal(first.sourceBuildId, second.sourceBuildId);
    assert.notEqual(first.manifest.buildId, second.manifest.buildId);
    assert.match(await readFile(join(second.dist, "client", "robots.txt"), "utf8"), /https:\/\/two\.example\.test\/sitemap\.xml/);
    assert.doesNotMatch(await readFile(join(second.dist, "client", "robots.txt"), "utf8"), /one\.example\.test/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("server returns an error instead of falling back when the served manifest is missing or invalid", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-serve-manifest-fixture-"));
  try {
    const dist = join(fixture, "dist");
    await writeFixture(join(fixture, "artifact"));
    await packageArtifact(join(fixture, "artifact"), dist);
    await rm(join(dist, "client", "ferrite-server.json"));
    const missingServer = createSiteServer(dist).listen(0, "127.0.0.1");
    await new Promise((resolve) => missingServer.once("listening", resolve));
    try {
      assert.equal((await request(missingServer, "/")).response.status, 500);
    } finally {
      await close(missingServer);
    }
    await writeFile(join(dist, "client", "ferrite-server.json"), "{}");
    const malformedServer = createSiteServer(dist).listen(0, "127.0.0.1");
    await new Promise((resolve) => malformedServer.once("listening", resolve));
    try {
      assert.equal((await request(malformedServer, "/")).response.status, 500);
    } finally {
      await close(malformedServer);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

for (const [label, mutate, expected = /invalid Ferrite production artifact/] of [
  ["malformed manifest", (manifest) => ({ ...manifest, routes: "not-an-array" })],
  ["unsafe path", (manifest) => ({ ...manifest, files: [{ ...manifest.files[0], path: "../escape" }] })],
  ["duplicate file", (manifest) => ({ ...manifest, files: [...manifest.files, manifest.files[0]] })],
  ["undeclared public file", (manifest) => ({ ...manifest, publicFiles: [...manifest.publicFiles, "missing.svg"] })],
  ["reserved public file", (manifest) => ({ ...manifest, publicFiles: ["server/home.mjs"] })],
  ["noncanonical prerendered route alias", (manifest) => {
    const routes = structuredClone(manifest.routes);
    routes[1].prerendered["/docs/"] = "docs/index.html";
    const result = { ...manifest, routes };
    result.buildId = computeManifestBuildId(result);
    return result;
  }, /canonical absolute URL path/],
]) {
  test(`fails closed on ${label} without deleting an existing dist`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "ferrite-invalid-fixture-"));
    const dist = join(fixture, "dist");
    try {
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "sentinel"), "keep me");
      const artifact = join(fixture, "artifact");
      await writeFixture(artifact);
      const malformed = mutate(validManifest(fixtureFiles));
      await writeFile(join(artifact, "ferrite-server.json"), JSON.stringify(malformed));
      await assert.rejects(packageArtifact(artifact, dist), expected);
      assert.equal(await readFile(join(dist, "sentinel"), "utf8"), "keep me");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}

test("fails closed on a missing or syntactically malformed manifest and rejects undeclared files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-missing-manifest-"));
  try {
    const artifact = join(fixture, "artifact");
    await writeFixture(artifact, { extra: ["undeclared.js"] });
    await rm(join(artifact, "ferrite-server.json"));
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-missing")), /manifest/);
    await writeFile(join(artifact, "ferrite-server.json"), "{not-json");
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-malformed")), /malformed|Unexpected token/);
    await writeFixture(artifact, { extra: ["undeclared.js"] });
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-undeclared")), /undeclared artifact file/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("fails closed on size/hash drift and symlinked files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-integrity-fixture-"));
  try {
    const artifact = join(fixture, "artifact");
    await writeFixture(artifact);
    const drifted = validManifest(fixtureFiles);
    drifted.files = drifted.files.map((file) => file.path === "index.html" ? { ...file, size: file.size + 1 } : file);
    await writeFile(join(artifact, "ferrite-server.json"), JSON.stringify(drifted));
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-size")), /buildId mismatch|size mismatch/);
    await writeFixture(artifact);
    const hashDrifted = validManifest(fixtureFiles);
    hashDrifted.files = hashDrifted.files.map((file) => file.path === "index.html" ? { ...file, sha256: "0".repeat(64) } : file);
    hashDrifted.buildId = computeManifestBuildId(hashDrifted);
    await writeFile(join(artifact, "ferrite-server.json"), JSON.stringify(hashDrifted));
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-hash")), /SHA-256 mismatch/);
    await writeFixture(artifact);
    await symlink(join(artifact, "index.html"), join(artifact, "link.html"));
    const symlinkManifest = validManifest({ ...fixtureFiles, "link.html": fixtureFiles["index.html"] });
    await writeFile(join(artifact, "ferrite-server.json"), JSON.stringify(symlinkManifest));
    await assert.rejects(packageArtifact(artifact, join(fixture, "dist-link")), /symlink|undeclared/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("staged partial writes are rejected before activation", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-stage-fixture-"));
  const dist = join(fixture, "dist");
  try {
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "sentinel"), "keep me");
    await writeFixture(join(fixture, "artifact"));
    let tampered = false;
    const fs = { ...fsPromises };
    const originalWrite = fs.writeFile;
    fs.writeFile = async (path, bytes, ...rest) => {
      if (!tampered && String(path).endsWith("/docs/index.html")) {
        tampered = true;
        return originalWrite(path, Buffer.from("tampered"), ...rest);
      }
      return originalWrite(path, bytes, ...rest);
    };
    await assert.rejects(packageArtifact(join(fixture, "artifact"), dist, { fs }), /staged output integrity mismatch|bytes differ/);
    assert.equal(await readFile(join(dist, "sentinel"), "utf8"), "keep me");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("atomic replacement rolls back activation failures and preserves rollback failures", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ferrite-transaction-fixture-"));
  try {
    const dist = join(fixture, "dist");
    const staging = join(fixture, "staging");
    await mkdir(dist, { recursive: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(dist, "sentinel"), "old");
    await writeFile(join(staging, "sentinel"), "new");
    const fs = fsPromises;
    let renameCalls = 0;
    const failingActivation = { ...fs, rename: async (...args) => { renameCalls += 1; if (renameCalls === 2) throw new Error("activation rename failed"); return fs.rename(...args); } };
    await assert.rejects(atomicReplaceDirectory(staging, dist, failingActivation), /activation rename failed/);
    assert.equal(await readFile(join(dist, "sentinel"), "utf8"), "old");

    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "sentinel"), "new");
    renameCalls = 0;
    const failingRollback = { ...fs, rename: async (...args) => { renameCalls += 1; if (renameCalls === 2 || renameCalls === 3) throw new Error("rollback rename failed"); return fs.rename(...args); } };
    await assert.rejects(atomicReplaceDirectory(staging, dist, failingRollback), /rollback failed|backup preserved/);
    const entries = await readdir(fixture);
    assert.ok(entries.some((entry) => entry.includes("backup-")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
