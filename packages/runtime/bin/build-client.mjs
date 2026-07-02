#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const [, , pageFile, outDirArg, publicPathArg, routePath = "/", propsJson = "{}", layoutsJson = "[]"] = process.argv;

if (!pageFile || !outDirArg || !publicPathArg) {
  console.error("usage: build-client <page-file> <out-dir> <public-path> [route-path] [props-json] [layouts-json]");
  process.exit(2);
}

let props;
let layoutFiles;
try {
  props = JSON.parse(propsJson);
} catch (error) {
  console.error(`invalid props JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
try {
  layoutFiles = JSON.parse(layoutsJson);
} catch (error) {
  console.error(`invalid layouts JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!Array.isArray(layoutFiles) || layoutFiles.some((file) => typeof file !== "string")) {
  console.error("layouts JSON must be an array of file paths");
  process.exit(2);
}

const projectRoot = await findNearestPackageRoot(resolve(pageFile));
const runtimeSrcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const outDir = resolve(outDirArg);
const publicPath = publicPathArg.replace(/\/$/, "");
const entryName = routeToEntryName(routePath);
await mkdir(outDir, { recursive: true });

if (!(await routeHasClientDirective([pageFile, ...layoutFiles]))) {
  const clientReferences = await collectClientReferences([pageFile, ...layoutFiles], projectRoot);
  const referenceBundles = await bundleClientReferences(clientReferences, projectRoot, outDir, publicPath);
  await writeResponse({
    script: null,
    styles: [],
    outputs: referenceBundles.outputs,
    sourcemaps: referenceBundles.sourcemaps,
    assets: referenceBundles.assets,
    clientReferences: referenceBundles.clientReferences,
    hydration: "server",
  });
  process.exit(0);
}

const tempRoot = join(projectRoot, ".ferrite", "tmp");
await mkdir(tempRoot, { recursive: true });
const tempDir = await mkdtemp(join(tempRoot, "client-"));
const entryFile = join(tempDir, `${entryName}.tsx`);

try {
  await writeFile(
    entryFile,
    [
      `import { createElement } from "@ferrite/runtime";`,
      `import { hydrate } from "@ferrite/runtime/dom";`,
      `import Page from ${JSON.stringify(resolve(pageFile))};`,
      ...layoutFiles.map((file, index) => `import Layout${index} from ${JSON.stringify(resolve(file))};`),
      "",
      `const layouts = [${layoutFiles.map((_file, index) => `Layout${index}`).join(", ")}];`,
      `const page = createElement(Page, ${JSON.stringify(props)});`,
      `const tree = layouts.reduceRight((child, Layout) => createElement(Layout, { children: child }), page);`,
      `const root = document.getElementById("ferrite-root") || document.getElementById("ferrite-dev-root");`,
      `if (root) {`,
      `  hydrate(tree, root);`,
      `}`,
      "",
    ].join("\n"),
  );

  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outdir: outDir,
    entryNames: entryName,
    assetNames: "assets/[name]-[hash]",
    sourcemap: true,
    metafile: true,
    jsx: "automatic",
    jsxImportSource: "@ferrite/runtime",
    plugins: [ferriteRuntimeAliasPlugin()],
    loader: {
      ".png": "file",
      ".jpg": "file",
      ".jpeg": "file",
      ".gif": "file",
      ".svg": "file",
      ".webp": "file",
      ".woff": "file",
      ".woff2": "file",
    },
    logLevel: "silent",
  });

  const summary = summarizeBuildResult(result, outDir, entryFile, publicPath);

  const response = {
    script: summary.script,
    styles: summary.styles,
    outputs: summary.outputs,
    sourcemaps: summary.sourcemaps,
    assets: summary.assets,
    clientReferences: [],
  };

  await writeResponse(response);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function routeToEntryName(route) {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "route-index";
  }
  return `route-${trimmed.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "index"}`;
}

function relativeOut(outDir, outputPath) {
  return relative(outDir, resolve(outputPath)).split(sep).join("/");
}

function publicUrl(publicPath, relativePath) {
  return `${publicPath}/${relativePath}`.replace(/\/{2,}/g, "/");
}

async function writeResponse(response) {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

function ferriteRuntimeAliasPlugin() {
  return {
    name: "ferrite-runtime-alias",
    setup(build) {
      build.onResolve({ filter: /^@ferrite\/runtime(?:\/.*)?$/ }, (args) => {
        if (args.path === "@ferrite/runtime") {
          return { path: join(runtimeSrcRoot, "index.ts") };
        }
        if (args.path === "@ferrite/runtime/dom") {
          return { path: join(runtimeSrcRoot, "dom.ts") };
        }
        if (args.path === "@ferrite/runtime/jsx-runtime") {
          return { path: join(runtimeSrcRoot, "jsx-runtime.ts") };
        }
        return undefined;
      });
    },
  };
}

async function bundleClientReferences(clientReferences, projectRoot, outDir, publicPath) {
  const bundledReferences = [];
  const outputs = new Set();
  const sourcemaps = new Set();
  const assets = new Set();

  for (const clientReference of clientReferences) {
    const summary = await bundleClientReference(clientReference, projectRoot, outDir, publicPath);
    bundledReferences.push({
      id: clientReference.id,
      module: clientReference.module,
      exportName: clientReference.exportName,
      script: summary.script,
      styles: summary.styles,
      outputs: summary.outputs,
      sourcemaps: summary.sourcemaps,
      assets: summary.assets,
    });
    for (const output of summary.outputs) {
      outputs.add(output);
    }
    for (const sourcemap of summary.sourcemaps) {
      sourcemaps.add(sourcemap);
    }
    for (const asset of summary.assets) {
      assets.add(asset);
    }
  }

  return {
    clientReferences: bundledReferences,
    outputs: [...outputs].sort(),
    sourcemaps: [...sourcemaps].sort(),
    assets: [...assets].sort(),
  };
}

async function bundleClientReference(clientReference, projectRoot, outDir, publicPath) {
  const tempRoot = join(projectRoot, ".ferrite", "tmp");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "client-reference-"));
  const entryName = clientReferenceEntryName(clientReference);
  const entryFile = join(tempDir, `${entryName}.tsx`);

  try {
    await writeFile(entryFile, clientReferenceEntrySource(clientReference));
    const result = await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      outdir: outDir,
      entryNames: entryName,
      assetNames: "assets/[name]-[hash]",
      sourcemap: true,
      metafile: true,
      jsx: "automatic",
      jsxImportSource: "@ferrite/runtime",
      plugins: [ferriteRuntimeAliasPlugin()],
      loader: {
        ".png": "file",
        ".jpg": "file",
        ".jpeg": "file",
        ".gif": "file",
        ".svg": "file",
        ".webp": "file",
        ".woff": "file",
        ".woff2": "file",
      },
      logLevel: "silent",
    });
    return summarizeBuildResult(result, outDir, entryFile, publicPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function clientReferenceEntrySource(clientReference) {
  return [
    `import { hydrateClientReference } from "@ferrite/runtime/dom";`,
    clientReferenceImportStatement(clientReference),
    "",
    `const registration = {`,
    `  id: ${JSON.stringify(clientReference.id)},`,
    `  module: ${JSON.stringify(clientReference.module)},`,
    `  exportName: ${JSON.stringify(clientReference.exportName)},`,
    `  component: ClientReferenceComponent,`,
    `};`,
    `const registry = globalThis.__FERRITE_CLIENT_REFERENCES__ || (globalThis.__FERRITE_CLIENT_REFERENCES__ = {});`,
    `registry[${JSON.stringify(clientReference.id)}] = registration;`,
    `function hydrateMarkedIslands() {`,
    `  hydrateClientReference(registration);`,
    `}`,
    `if (typeof document !== "undefined") {`,
    `  if (document.readyState === "loading") {`,
    `    document.addEventListener("DOMContentLoaded", hydrateMarkedIslands, { once: true });`,
    `  } else {`,
    `    hydrateMarkedIslands();`,
    `  }`,
    `}`,
    "",
  ].join("\n");
}

function clientReferenceImportStatement(clientReference) {
  const source = JSON.stringify(clientReference.file);
  if (clientReference.exportName === "default") {
    return `import ClientReferenceComponent from ${source};`;
  }
  if (clientReference.exportName === "*") {
    return `import * as ClientReferenceComponent from ${source};`;
  }
  return `import { ${clientReference.exportName} as ClientReferenceComponent } from ${source};`;
}

function clientReferenceEntryName(clientReference) {
  return `client-reference-${clientReference.id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "index"}`;
}

function summarizeBuildResult(result, outDir, entryFile, publicPath) {
  const outputs = Object.entries(result.metafile.outputs);
  const entryOutput =
    outputs.find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entryFile) ??
    outputs.find(([, output]) => output.entryPoint);
  if (!entryOutput) {
    throw new Error(`Could not find esbuild entry output for ${entryFile}`);
  }

  const [entryOutputPath, entryMeta] = entryOutput;
  const sourcemaps = outputs
    .map(([outputPath]) => outputPath)
    .filter((outputPath) => outputPath.endsWith(".map"))
    .map((outputPath) => relativeOut(outDir, outputPath))
    .sort();
  const assets = outputs
    .map(([outputPath, output]) => [outputPath, output])
    .filter(([outputPath, output]) => !outputPath.endsWith(".js") && !outputPath.endsWith(".css") && !outputPath.endsWith(".map") && !output.entryPoint)
    .map(([outputPath]) => relativeOut(outDir, outputPath))
    .sort();

  return {
    script: publicUrl(publicPath, relativeOut(outDir, entryOutputPath)),
    styles: entryMeta.cssBundle ? [publicUrl(publicPath, relativeOut(outDir, entryMeta.cssBundle))] : [],
    outputs: outputs.map(([outputPath]) => relativeOut(outDir, outputPath)).sort(),
    sourcemaps,
    assets,
  };
}

async function collectClientReferences(entryFiles, projectRoot) {
  const references = new Map();
  const visited = new Set();

  for (const entryFile of entryFiles) {
    const resolved = await resolveSourceFile(resolve(entryFile));
    if (resolved) {
      await scanServerFileForClientReferences(resolved, projectRoot, visited, references);
    }
  }

  return [...references.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function scanServerFileForClientReferences(file, projectRoot, visited, references) {
  const resolvedFile = resolve(file);
  if (visited.has(resolvedFile)) {
    return;
  }
  visited.add(resolvedFile);

  const source = await readFile(resolvedFile, "utf8");
  if (startsWithDirective(source, "use client")) {
    return;
  }

  for (const importRecord of parseRelativeImportRecords(source)) {
    const importedFile = await resolveSourceFile(resolve(dirname(resolvedFile), importRecord.specifier));
    if (!importedFile) {
      continue;
    }

    const importedSource = await readFile(importedFile, "utf8");
    if (startsWithDirective(importedSource, "use client")) {
      for (const exportName of importRecord.exportNames) {
        const module = relative(projectRoot, importedFile).split(sep).join("/");
        const id = `${module}#${exportName}`;
        references.set(id, { id, module, exportName, file: importedFile });
      }
      continue;
    }

    await scanServerFileForClientReferences(importedFile, projectRoot, visited, references);
  }
}

function parseRelativeImportRecords(source) {
  const records = [];

  for (const match of source.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) {
      continue;
    }
    records.push({
      specifier: match[3],
      exportNames: parseImportedExportNames(match[2]),
    });
  }

  for (const match of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    records.push({
      specifier: match[1],
      exportNames: [],
    });
  }

  for (const match of source.matchAll(/\bexport\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) {
      continue;
    }
    records.push({
      specifier: match[3],
      exportNames: parseNamedExportNames(match[2]),
    });
  }

  for (const match of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
    records.push({
      specifier: match[1],
      exportNames: ["*"],
    });
  }

  return records.filter((record) => isRelativeSpecifier(record.specifier) && isSourceSpecifier(record.specifier));
}

function parseImportedExportNames(clause) {
  const names = [];
  const trimmed = clause.trim();
  if (!trimmed) {
    return names;
  }

  if (trimmed.startsWith("*")) {
    return ["*"];
  }

  if (!trimmed.startsWith("{")) {
    names.push("default");
  }

  const namedStart = trimmed.indexOf("{");
  const namedEnd = trimmed.lastIndexOf("}");
  if (namedStart !== -1 && namedEnd !== -1 && namedEnd > namedStart) {
    names.push(...parseNamedExportNames(trimmed.slice(namedStart + 1, namedEnd)));
  }

  return [...new Set(names)];
}

function parseNamedExportNames(namedClause) {
  return namedClause
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const withoutType = part.replace(/^type\s+/, "").trim();
      if (!withoutType || part.startsWith("type ")) {
        return [];
      }
      const [exportName] = withoutType.split(/\s+as\s+/);
      return exportName ? [exportName.trim()] : [];
    });
}

function isSourceSpecifier(specifier) {
  const extension = extname(specifier);
  return !extension || [".tsx", ".ts", ".jsx", ".js"].includes(extension);
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

async function resolveSourceFile(path) {
  const candidates = extname(path)
    ? [path]
    : [
        ...[".tsx", ".ts", ".jsx", ".js"].map((extension) => `${path}${extension}`),
        ...[".tsx", ".ts", ".jsx", ".js"].map((extension) => join(path, `index${extension}`)),
      ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return resolve(candidate);
    } catch (_error) {
      // Try the next source-file candidate.
    }
  }

  return null;
}

async function routeHasClientDirective(files) {
  for (const file of files) {
    if (await fileHasUseClientDirective(file)) {
      return true;
    }
  }
  return false;
}

async function fileHasUseClientDirective(file) {
  const source = await readFile(file, "utf8");
  return startsWithDirective(source, "use client");
}

function startsWithDirective(source, directive) {
  let rest = source.replace(/^\uFEFF/, "");
  while (true) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const newline = trimmed.indexOf("\n");
      rest = newline === -1 ? "" : trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) {
        return false;
      }
      rest = trimmed.slice(end + 2);
      continue;
    }
    rest = trimmed;
    break;
  }

  const escaped = directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(['"])${escaped}\\1\\s*;?`).test(rest);
}

async function findNearestPackageRoot(filePath) {
  let current = dirname(filePath);
  while (true) {
    try {
      await access(join(current, "package.json"));
      return current;
    } catch (_error) {
      const parent = dirname(current);
      if (parent === current) {
        return process.cwd();
      }
      current = parent;
    }
  }
}
