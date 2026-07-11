#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { build } from "esbuild";

const CLIENT_ORIGINAL_SUFFIX = "?ferrite-client-original";

const args = process.argv.slice(2);
const prebuiltArtifact = args[0] === "--prebuilt";
if (prebuiltArtifact) {
  args.shift();
}
if (args[0] === "--build-artifact") {
  try {
    await buildServerArtifact(args.slice(1));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
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

if (prebuiltArtifact) {
  try {
    const entryModule = await import(`${pathToFileURL(resolve(pageFile)).href}?t=${Date.now()}`);
    await executeEntryModule(entryModule, serverRuntimeFromEntry(entryModule));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
} else {
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
      serverArtifactEntrySource({
        pageFile,
        layoutFiles,
        documentFile: documentMode ? documentFile : undefined,
        conventionFiles,
        routePattern: routePatternFromPageFile(pageFile, projectRoot),
      }),
    );

    await bundleServerArtifact({
      entryFile,
      outputFile: bundleFile,
      projectRoot,
      excludedFiles: clientReferenceExcludedFiles,
    });

    const entryModule = await import(`${pathToFileURL(bundleFile).href}?t=${Date.now()}`);
    await executeEntryModule(entryModule, serverRuntimeFromEntry(entryModule));
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function serverRuntimeFromEntry(entryModule) {
  const server = entryModule.serverRuntime;
  if (!server || typeof server.renderPageModuleToPacket !== "function") {
    throw new TypeError("Ferrite server artifact is missing its bundled server runtime.");
  }
  return server;
}

async function executeEntryModule(entryModule, server) {
  const routePattern = entryModule.routePattern ?? routePatternFromPageFile(pageFile, projectRoot);
  const routeRenderMode = mode === "render" || mode === "--stream" || mode === "--server-payload";
  const effectiveRouteRenderOptions = routeRenderMode && routePattern
    ? {
        ...routeRenderOptions,
        routePath: concreteRoutePathFromPattern(routePattern, props.params ?? {}),
        routePattern,
      }
    : routeRenderOptions;
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
      effectiveRouteRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(stream)}\n`);
  } else if (mode === "--server-payload") {
    const payload = await server.renderPageModuleToServerPayload(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      effectiveRouteRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (mode === "--server-action") {
    const response = await server.invokeServerActionFromPageModule(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      actionRequest,
      { routePattern },
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else if (mode === "--server-action-manifest") {
    const manifest = await server.collectServerActionsFromPageModule(
      entryModule.pageModule,
      props,
      entryModule.layoutModules,
      entryModule.conventionModules,
      {
        routePath: concreteRoutePathFromPattern(routePattern, props.params ?? {}),
        routePattern,
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
      effectiveRouteRenderOptions,
    );
    process.stdout.write(`${JSON.stringify(serializable)}\n`);
  }
}

async function buildServerArtifact(buildArgs) {
  const [sourcePageFile, outputFile, layoutsJson = "[]", documentJson = "null", conventionsJson = "{}", routePattern] =
    buildArgs;
  if (!sourcePageFile || !outputFile || !routePattern) {
    throw new TypeError(
      "usage: render-page --build-artifact <page-file> <output-file> <layouts-json> <document-json> <conventions-json> <route-pattern>",
    );
  }

  const sourceLayouts = JSON.parse(layoutsJson);
  const sourceDocument = JSON.parse(documentJson);
  const sourceConventions = JSON.parse(conventionsJson);
  if (!Array.isArray(sourceLayouts) || sourceLayouts.some((file) => typeof file !== "string")) {
    throw new TypeError("artifact layouts JSON must be an array of file paths");
  }
  if (sourceDocument !== null && typeof sourceDocument !== "string") {
    throw new TypeError("artifact document JSON must be a file path or null");
  }
  if (!sourceConventions || typeof sourceConventions !== "object" || Array.isArray(sourceConventions)) {
    throw new TypeError("artifact conventions JSON must be an object");
  }
  for (const key of ["loading", "error"]) {
    if (sourceConventions[key] !== undefined && typeof sourceConventions[key] !== "string") {
      throw new TypeError(`artifact convention "${key}" must be a file path string when provided`);
    }
  }
  if (!routePattern.startsWith("/") || routePattern.includes("?") || routePattern.includes("#")) {
    throw new TypeError("artifact route pattern must be an absolute URL path pattern");
  }

  const resolvedPage = resolve(sourcePageFile);
  const resolvedLayouts = sourceLayouts.map((file) => resolve(file));
  const resolvedDocument = sourceDocument === null ? undefined : resolve(sourceDocument);
  const resolvedConventions = Object.fromEntries(
    Object.entries(sourceConventions).map(([key, file]) => [key, resolve(file)]),
  );
  const artifactProjectRoot = await realSourcePath(await findNearestPackageRoot(resolvedPage));
  const excludedFiles = new Set(
    await Promise.all(
      [resolvedPage, ...resolvedLayouts, resolvedDocument, resolvedConventions.loading, resolvedConventions.error]
        .filter((file) => typeof file === "string")
        .map((file) => realSourcePath(file)),
    ),
  );
  const tempRoot = join(artifactProjectRoot, ".ferrite", "tmp");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "server-artifact-"));
  const entryFile = join(tempDir, "entry.mjs");

  try {
    await writeFile(
      entryFile,
      serverArtifactEntrySource({
        pageFile: resolvedPage,
        layoutFiles: resolvedLayouts,
        documentFile: resolvedDocument,
        conventionFiles: resolvedConventions,
        routePattern,
      }),
    );
    await mkdir(dirname(resolve(outputFile)), { recursive: true });
    await bundleServerArtifact({
      entryFile,
      outputFile: resolve(outputFile),
      projectRoot: artifactProjectRoot,
      excludedFiles,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function serverArtifactEntrySource({ pageFile, layoutFiles, documentFile, conventionFiles, routePattern }) {
  return [
    `import * as serverRuntime from "@ferrite/runtime/server";`,
    `import * as pageModule from ${JSON.stringify(resolve(pageFile))};`,
    ...layoutFiles.map((file, index) => `import * as layout${index} from ${JSON.stringify(resolve(file))};`),
    ...(documentFile ? [`import * as documentModuleImport from ${JSON.stringify(resolve(documentFile))};`] : []),
    ...(conventionFiles.loading
      ? [`import * as loadingModule from ${JSON.stringify(resolve(conventionFiles.loading))};`]
      : []),
    ...(conventionFiles.error
      ? [`import * as errorModule from ${JSON.stringify(resolve(conventionFiles.error))};`]
      : []),
    "export { pageModule, serverRuntime };",
    `export const layoutModules = [${layoutFiles.map((_file, index) => `layout${index}`).join(", ")}];`,
    `export const documentModule = ${documentFile ? "documentModuleImport" : "null"};`,
    `export const conventionModules = {${[
      conventionFiles.loading ? "loading: loadingModule" : "",
      conventionFiles.error ? "error: errorModule" : "",
    ]
      .filter(Boolean)
      .join(", ")}};`,
    `export const routePattern = ${JSON.stringify(routePattern ?? null)};`,
    "",
  ].join("\n");
}

async function bundleServerArtifact({ entryFile, outputFile, projectRoot, excludedFiles }) {
  const result = await build({
    entryPoints: [entryFile],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    jsxImportSource: "@ferrite/runtime",
    plugins: [clientReferenceProxyPlugin({ projectRoot, excludedFiles })],
    loader: {
      ".css": "empty",
    },
    legalComments: "none",
    minify: true,
    metafile: true,
    logLevel: "silent",
  });
  const unsupportedExternals = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((item) => item.external && !isBuiltin(item.path))
    .map((item) => item.path);
  if (unsupportedExternals.length > 0) {
    throw new TypeError(
      `Ferrite server artifacts cannot depend on external packages: ${[...new Set(unsupportedExternals)].sort().join(", ")}`,
    );
  }
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
  const routePattern = routePatternFromPageFile(pageFile, projectRoot);
  return concreteRoutePathFromPattern(routePattern, params);
}

function concreteRoutePathFromPattern(routePattern, params) {
  if (routePattern === "/") {
    return "/";
  }
  if (typeof routePattern !== "string" || !routePattern.startsWith("/")) {
    throw new TypeError("Ferrite route pattern is unavailable for this server artifact.");
  }
  const routeSegments = routePattern.slice(1).split("/");
  const concreteSegments = routeSegments.map((segment) => concretePatternSegment(segment, params));
  return `/${concreteSegments.flat().join("/")}`;
}

function concretePatternSegment(segment, params) {
  if (segment.startsWith(":")) {
    const name = segment.slice(1);
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Ferrite route param "${name}" must be a non-empty string for ${segment}.`);
    }
    return encodeRouteSegment(value);
  }
  if (segment.startsWith("*")) {
    const optional = segment.endsWith("?");
    const name = segment.slice(1, optional ? -1 : undefined);
    const value = params[name];
    if (optional && value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || (!optional && value.length === 0)) {
      throw new TypeError(`Ferrite route param "${name}" must be ${optional ? "an array" : "a non-empty array"} for ${segment}.`);
    }
    return value.map(encodeRouteSegment);
  }
  return segment;
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
