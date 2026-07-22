import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);
let renderSequence = 0;

async function render(headers = { accept: "text/html" }) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${renderSequence++}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers,
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the source-backed Ferrite site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Ferrite[^<]*Rust-first application framework<\/title>/i);
  assert.match(html, /Rust owns the control plane/);
  assert.match(html, /<h1[^>]*>Ferrite<\/h1>/);
  assert.match(html, /Open-source developer preview/);
  assert.match(html, />509<\/strong>/);
  assert.match(html, />10<\/strong>/);
  assert.match(html, />Captured<\/strong><span>Rust dev-server coverage report<\/span>/);
  assert.match(html, />Available<\/span>/);
  assert.match(html, />Partial<\/span>/);
  assert.match(html, />Experimental<\/span>/);
  assert.match(html, />Planned<\/span>/);
  assert.match(html, /exact local artifact-backed serve/);
  assert.match(html, /8716f30/);
  assert.match(html, /docs-home-desktop\.png/);
  assert.match(html, /docs-guide-desktop\.png/);
  assert.match(html, /docs-catchall-desktop\.png/);
  assert.match(html, /docs-mobile-nav\.png/);
  assert.doesNotMatch(html, /_vinext\/image\?/);
  assert.match(html, /\/guides\/architecture/);
  assert.match(html, /application-level unavailable state/);
  assert.match(html, /id="content" tabindex="-1"/);
  assert.match(html, /FERRITE_ACTION_CSRF/);
  assert.match(html, /FERRITE_PUBLIC_ORIGIN/);
  assert.match(html, /pnpm install --frozen-lockfile/);
  assert.match(html, /--project examples\/basic/);
  assert.doesNotMatch(html, /pnpm test:demos/);
  assert.match(html, /https:\/\/github\.com\/integrate-your-mind\/ferrite/);
  assert.match(html, /http:\/\/localhost(?::\d+)?\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  assert.doesNotMatch(html, /404 behavior|target="_blank"/i);
});

test("does not derive public metadata from request-controlled proxy headers", async () => {
  const response = await render({
    accept: "text/html",
    host: "attacker.example",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "javascript",
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /http:\/\/localhost(?::\d+)?\/og\.png/);
  assert.doesNotMatch(html, /attacker\.example|javascript:/);
});

test("accepts only an explicit HTTP or HTTPS origin for public metadata", async () => {
  const previousOrigin = process.env.FERRITE_SITE_ORIGIN;

  try {
    process.env.FERRITE_SITE_ORIGIN = "https://preview.example.test";
    const response = await render();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /https:\/\/preview\.example\.test\/og\.png/);

    for (const invalidOrigin of [
      "preview.example.test",
      "javascript:alert(1)",
      "https://user:secret@preview.example.test",
      "https://preview.example.test/path/..",
      "https://preview.example.test/%2e",
      "https://preview.example.test?query=1",
      "https://preview.example.test#fragment",
    ]) {
      process.env.FERRITE_SITE_ORIGIN = invalidOrigin;
      await assert.rejects(render(), /FERRITE_SITE_ORIGIN must be/);
    }
  } finally {
    if (previousOrigin === undefined) {
      delete process.env.FERRITE_SITE_ORIGIN;
    } else {
      process.env.FERRITE_SITE_ORIGIN = previousOrigin;
    }
  }
});

test("keeps the published source free of initializer artifacts", async () => {
  const [page, layout, packageJson, css, readme, worker, viteConfig, sitesPlugin] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../build/sites-vite-plugin.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /codex-preview|SkeletonPreview|Starter Project/i);
  assert.doesNotMatch(page, /Visual capture pending|placeholder|\+\s+--|notFound\(\)|404 behavior/i);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview|Starter Project/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(packageJson, /drizzle|db:generate/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /site-header nav/);
  assert.match(css, /focus-visible/);
  assert.doesNotMatch(readme, /\\`/);
  assert.match(readme, /```bash[\s\S]*npm run dev[\s\S]*```/);
  assert.doesNotMatch(worker, /vinext-starter|Starter Project/i);
  assert.doesNotMatch(viteConfig, /site-creator|d1_databases|r2_buckets/i);
  assert.doesNotMatch(sitesPlugin, /drizzle|migration/i);

  await assert.rejects(access(previewRoot));
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
  await assert.rejects(access(new URL("../drizzle.config.ts", import.meta.url)));
  await assert.rejects(access(new URL("../db", import.meta.url)));
  await assert.rejects(access(new URL("../examples/d1", import.meta.url)));
  await access(new URL("../public/ferrite-mark.svg", import.meta.url));
  await access(new URL("../public/og.png", import.meta.url));
  for (const asset of ["docs-home-desktop.png", "docs-guide-desktop.png", "docs-catchall-desktop.png", "docs-mobile-nav.png", "capture-manifest.json", "CAPTURE_RECEIPT.md"]) {
    await access(new URL(`../public/demos/${asset}`, import.meta.url));
  }
});

test("pins every demo capture to the exact source and recorded digest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/demos/capture-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.source.commit, "8716f30c83b9e4fc0835c2f37f9c00bd26e8152d");
  assert.equal(manifest.source.baseCommit, "8539f4a9288321f002658cebf6ac25a9bd952519");
  assert.equal(manifest.source.buildId, "sha256:d54c36b56cc5dff3217c8ae6dc96e907733f5da302714341b5a8413f8d8af99d");
  assert.deepEqual(manifest.captures.map((capture) => capture.route), ["/", "/guides/architecture", "/guides/unlisted/path", "/"]);

  for (const capture of manifest.captures) {
    const image = await readFile(new URL(`../public/demos/${capture.file}`, import.meta.url));
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    const dimensions = `${image.readUInt32BE(16)}x${image.readUInt32BE(20)}`;
    assert.equal(dimensions, capture.viewport);
    assert.equal(createHash("sha256").update(image).digest("hex"), capture.sha256);
  }
});

test("every on-page navigation link has a matching section", async () => {
  const response = await render();
  const html = await response.text();
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);

  assert.ok(anchors.length > 0);
  for (const id of anchors) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
