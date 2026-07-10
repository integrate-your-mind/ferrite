#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { build } from "esbuild";

const CLIENT_ORIGINAL_SUFFIX = "?ferrite-client-original";

const args = process.argv.slice(2);
const knownModes = new Set([
  "--static-params",
  "--metadata",
  "--stream",
  "--server-payload",
  "--document",
  "--document-stream",
  "--document-server-payload",
  "--server-action",
  "--server-action-manifest",
]);
const mode = knownModes.has(args[0]) ? args.shift() : "render";
const [pageFile, propsJson = "{}", layoutsJson = "[]", fourthArg, fifthArg = "{}", sixthArg = "{}"] = args;
const documentMode = mode === "--document" || mode === "--document-stream" || mode === "--document-server-payload";
const serverActionMode = mode === "--server-action";
const documentFile = documentMode ? fourthArg : undefined;
const documentOptionsJson = documentMode ? fifthArg : "{}";
const actionRequestJson = serverActionMode ? fifthArg : "{}";
const routeRenderOptionsJson = documentMode || serverActionMode ? "{}" : fifthArg;
const conventionsJson = documentMode ? sixthArg : (fourthArg ?? "{}");

if (!pageFile) {
  console.error(
    "usage: render-page [--static-params|--metadata|--stream|--server-payload|--document|--document-stream|--document-server-payload|--server-action|--server-action-manifest] <page-file> [props-json] [layouts-json] [document-file|conventions-json] [document-options-json|action-request-json]",
  );
  process.exit(2);
}

let props = {};
let layoutFiles = [];
if (mode !== "--static-params") {
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
}

let documentOptions = {};
if (documentMode) {
  if (!documentFile) {
    console.error(`${mode} requires a document file path`);
    process.exit(2);
  }

  try {
    documentOptions = JSON.parse(documentOptionsJson);
  } catch (error) {
    console.error(`invalid document options JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

let routeRenderOptions = {};
if (!documentMode && !serverActionMode) {
  try {
    routeRenderOptions = JSON.parse(routeRenderOptionsJson);
  } catch (error) {
    console.error(`invalid render options JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

let actionRequest = {};
if (serverActionMode) {
  try {
    actionRequest = JSON.parse(actionRequestJson);
  } catch (error) {
    console.error(`invalid server action request JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

let conventionFiles = {};
if (mode !== "--static-params" && mode !== "--metadata") {
  try {
    conventionFiles = JSON.parse(conventionsJson);
  } catch (error) {
    console.error(`invalid route conventions JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  if (conventionFiles === null || typeof conventionFiles !== "object" || Array.isArray(conventionFiles)) {
    console.error("route conventions JSON must be an object");
    process.exit(2);
  }

  for (const key of ["loading", "error"]) {
    if (conventionFiles[key] !== undefined && typeof conventionFiles[key] !== "string") {
      console.error(`route conventions "${key}" must be a file path string when provided`);
      process.exit(2);
    }
  }
}

const projectRoot = await realSourcePath(await findNearestPackageRoot(resolve(pageFile)));
const tempRoot = join(projectRoot, ".ferrite", "tmp");
await mkdir(tempRoot, { recursive: true });
const tempDir = await mkdtemp(join(tempRoot, "page-"));
const entryFile = join(tempDir, "entry.mjs");
const bundleFile = join(tempDir, "page.mjs");
const clientReferenceExcludedFiles = new Set(
  await Promise.all(
    [pageFile, ...layoutFiles, documentFile, conventionFiles.loading, conventionFiles.error]
      .filter((file) => typeof file === "string")
      .map((file) => realSourcePath(file)),
  ),
);

try {
  await writeFile(
    entryFile,
    [
      `import * as pageModule from ${JSON.stringify(resolve(pageFile))};`,
      ...layoutFiles.map((file, index) => `import * as layout${index} from ${JSON.stringify(resolve(file))};`),
      ...(documentMode ? [`import * as documentModule from ${JSON.stringify(resolve(documentFile))};`] : []),
      ...(conventionFiles.loading
        ? [`import * as loadingModule from ${JSON.stringify(resolve(conventionFiles.loading))};`]
        : []),
      ...(conventionFiles.error
        ? [`import * as errorModule from ${JSON.stringify(resolve(conventionFiles.error))};`]
        : []),
      "export { pageModule };",
      `export const layoutModules = [${layoutFiles.map((_file, index) => `layout${index}`).join(", ")}];`,
      ...(documentMode ? ["export { documentModule };"] : []),
      `export const conventionModules = {${[
        conventionFiles.loading ? "loading: loadingModule" : "",
        conventionFiles.error ? "error: errorModule" : "",
      ]
        .filter(Boolean)
        .join(", ")}};`,
      "",
    ].join("\n"),
  );

  await build({
    entryPoints: [entryFile],
    outfile: bundleFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    external: ["@ferrite/runtime", "@ferrite/runtime/*"],
    jsx: "automatic",
    jsxImportSource: "@ferrite/runtime",
    plugins: [
      clientReferenceProxyPlugin({
        projectRoot,
        excludedFiles: clientReferenceExcludedFiles,
      }),
    ],
    loader: {
      ".css": "empty",
    },
    logLevel: "silent",
  });

  const [entryModule, server] = await Promise.all([
    import(`${pathToFileURL(bundleFile).href}?t=${Date.now()}`),
    import("@ferrite/runtime/server"),
  ]);
  if (mode === "--static-params") {
    const staticParams = await server.collectStaticParams(entryModule.pageModule);
    process.stdout.write(`${JSON.stringify(staticParams)}\n`);
  } else if (mode === "--metadata") {
    const metadata = await server.collectPageMetadata(entryModule.pageModule, props, entryModule.layoutModules);
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } else if (mode === "--stream") {
    const stream = await server.renderPageModuleToStreamPacket(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      routeRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(stream)}\n`);
  } else if (mode === "--server-payload") {
    const payload = await server.renderPageModuleToServerPayload(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      routeRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (mode === "--server-action") {
    const response = await server.invokeServerActionFromPageModule(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      actionRequest,
      { routePattern: routePatternFromPageFile(pageFile, projectRoot) },
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else if (mode === "--server-action-manifest") {
    const manifest = await server.collectServerActionsFromPageModule(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      {
        routePath: concreteRoutePathFromPageFile(pageFile, projectRoot, props.params ?? {}),
        routePattern: routePatternFromPageFile(pageFile, projectRoot),
      },
    );
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } else if (mode === "--document") {
    const document = await server.renderDocumentModuleToPacket(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.documentModule,
      documentOptions,
      entryModule.conventionModules,
    );
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else if (mode === "--document-stream") {
    const stream = await server.renderDocumentModuleToStreamPacket(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.documentModule,
      documentOptions,
      entryModule.conventionModules,
    );
    process.stdout.write(`${JSON.stringify(stream)}\n`);
  } else if (mode === "--document-server-payload") {
    const payload = await server.renderDocumentModuleToServerPayload(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.documentModule,
      documentOptions,
      entryModule.conventionModules,
    );
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    const serializable = await server.renderPageModuleToPacket(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      routeRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(serializable)}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function clientReferenceProxyPlugin({ projectRoot, excludedFiles }) {
  return {
    name: "ferrite-client-reference-proxy",
    setup(build) {
      build.onResolve({ filter: /\?ferrite-client-original$/ }, async (args) => {
        const request = args.path.slice(0, -CLIENT_ORIGINAL_SUFFIX.length);
        const absolute = isAbsolute(request) ? request : resolve(args.resolveDir, request);
        const resolved = await resolveSourceFile(absolute);
        if (!resolved) {
          return undefined;
        }
        return { path: resolved, namespace: "ferrite-client-original" };
      });

      build.onResolve({ filter: /^\./, namespace: "ferrite-client-original" }, async (args) => {
        const resolved = await resolveSourceFile(resolve(args.resolveDir, args.path));
        if (!resolved) {
          return undefined;
        }
        return { path: resolved, namespace: "ferrite-client-original" };
      });

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "ferrite-client-original" }, async (args) => ({
        contents: await readFile(args.path, "utf8"),
        loader: loaderForPath(args.path),
        resolveDir: dirname(args.path),
      }));

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const file = await realSourcePath(args.path);
        if (excludedFiles.has(file) || !isProjectSource(file, projectRoot)) {
          return undefined;
        }

        const source = await readFile(file, "utf8");
        if (!startsWithDirective(source, "use client")) {
          return undefined;
        }

        return {
          contents: clientReferenceProxySource(file, projectRoot, source),
          loader: "js",
          resolveDir: dirname(file),
        };
      });
    },
  };
}

function clientReferenceProxySource(file, projectRoot, source) {
  const module = relative(projectRoot, file).split(sep).join("/");
  const originalSource = `${file}${CLIENT_ORIGINAL_SUFFIX}`;
  const exports = parseClientExports(source);
  const lines = [`import { createClientReference } from "@ferrite/runtime/server";`];

  if (exports.hasDefault) {
    lines.push(`import __FerriteOriginalDefault from ${JSON.stringify(originalSource)};`);
    lines.push(
      `const __FerriteClientReferenceDefault = createClientReference({ id: ${JSON.stringify(`${module}#default`)}, render: __FerriteOriginalDefault });`,
    );
    lines.push("export default __FerriteClientReferenceDefault;");
  }

  exports.named.forEach((exportName, index) => {
    const local = `__FerriteOriginal${index}`;
    lines.push(`import { ${exportName} as ${local} } from ${JSON.stringify(originalSource)};`);
    lines.push(
      `export const ${exportName} = createClientReference({ id: ${JSON.stringify(`${module}#${exportName}`)}, render: ${local} });`,
    );
  });

  return `${lines.join("\n")}\n`;
}

function parseClientExports(source) {
  const named = new Set();
  let hasDefault = /\bexport\s+default\b/.test(source);

  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    named.add(match[1]);
  }

  for (const match of source.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    named.add(match[1]);
  }

  for (const match of source.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    named.add(match[1]);
  }

  for (const match of source.matchAll(/\bexport\s+\{([\s\S]*?)\}/g)) {
    for (const name of parseNamedExportNames(match[1])) {
      if (name === "default") {
        hasDefault = true;
      } else {
        named.add(name);
      }
    }
  }

  return {
    hasDefault,
    named: [...named].sort(),
  };
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
      const pieces = withoutType.split(/\s+as\s+/);
      const exportName = pieces[1] ?? pieces[0];
      return isIdentifier(exportName) ? [exportName] : [];
    });
}

function isIdentifier(value) {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function isProjectSource(file, projectRoot) {
  const projectRelative = relative(projectRoot, file);
  return (
    projectRelative.length > 0 &&
    !projectRelative.startsWith("..") &&
    !isAbsolute(projectRelative) &&
    !projectRelative.split(sep).includes("node_modules")
  );
}

function routePatternFromPageFile(pageFile, projectRoot) {
  const routeSegments = routeSegmentsFromPageFile(pageFile, projectRoot);
  if (!routeSegments) {
    return undefined;
  }

  const patternSegments = routeSegments.map(routePatternSegment);
  return patternSegments.length === 0 ? "/" : `/${patternSegments.join("/")}`;
}

function routeSegmentsFromPageFile(pageFile, projectRoot) {
  const parts = relative(projectRoot, resolve(pageFile)).split(sep);
  const appIndex = parts.lastIndexOf("app");
  if (appIndex === -1 || appIndex >= parts.length - 1) {
    return undefined;
  }

  return parts.slice(appIndex + 1, -1).filter((segment) => !isRouteGroupSegment(segment));
}

function routePatternSegment(segment) {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return `*${segment.slice(5, -2)}?`;
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `*${segment.slice(4, -1)}`;
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

function concreteRoutePathFromPageFile(pageFile, projectRoot, params) {
  const routeSegments = routeSegmentsFromPageFile(pageFile, projectRoot);
  if (!routeSegments || routeSegments.length === 0) {
    return "/";
  }

  const concreteSegments = routeSegments.map((segment) => concreteRouteSegment(segment, params));
  return `/${concreteSegments.flat().join("/")}`;
}

function concreteRouteSegment(segment, params) {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    const name = segment.slice(5, -2);
    const value = params[name];
    return Array.isArray(value) ? value.map(encodeRouteSegment) : [];
  }

  if (segment.startsWith("[...") && segment.endsWith("]")) {
    const name = segment.slice(4, -1);
    const value = params[name];
    if (!Array.isArray(value) || value.length === 0) {
      throw new TypeError(`Ferrite route param "${name}" must be a non-empty array for ${segment}.`);
    }
    return value.map(encodeRouteSegment);
  }

  if (segment.startsWith("[") && segment.endsWith("]")) {
    const name = segment.slice(1, -1);
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Ferrite route param "${name}" must be a non-empty string for ${segment}.`);
    }
    return encodeRouteSegment(value);
  }

  return segment;
}

function encodeRouteSegment(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Ferrite route params must contain non-empty string segments.");
  }
  return encodeURIComponent(value);
}

function isRouteGroupSegment(segment) {
  return segment.startsWith("(") && segment.endsWith(")");
}

function loaderForPath(path) {
  switch (extname(path)) {
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".jsx":
      return "jsx";
    default:
      return "js";
  }
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
      return realSourcePath(candidate);
    } catch (_error) {
      // Try the next source-file candidate.
    }
  }

  return null;
}

async function realSourcePath(path) {
  try {
    return await realpath(resolve(path));
  } catch (_error) {
    return resolve(path);
  }
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
