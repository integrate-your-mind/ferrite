#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { build, version as esbuildVersion } from "esbuild";

const CLIENT_ORIGINAL_SUFFIX = "?ferrite-client-original";
const SHA256_BUILD_ID = /^sha256:[a-f0-9]{64}$/;
const ZERO_SHA256_BUILD_ID = `sha256:${"0".repeat(64)}`;
const CLOUDFLARE_ROUTE_RECEIPT_FORMAT = "ferrite-cloudflare-route-receipt";
const CLOUDFLARE_RECEIPT_PACKAGES = Object.freeze([
  { name: "@ferrite/runtime", allowedPrefix: "dist/" },
  { name: "@ferrite/protocol", allowedPrefix: "dist/" },
]);
const requireFromRuntime = createRequire(import.meta.url);

const args = process.argv.slice(2);
const prebuiltArtifact = args[0] === "--prebuilt";
if (prebuiltArtifact) {
  args.shift();
}
if (args[0] === "--build-artifact") {
  try {
    await buildServerArtifact(args.slice(1), "node");
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "--build-cloudflare-artifact") {
  try {
    await buildServerArtifact(args.slice(1), "cloudflare");
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "--verify-cloudflare-artifact-receipt") {
  try {
    const verified = await verifyCloudflareArtifactReceipt(args.slice(1));
    process.stdout.write(`${JSON.stringify(verified)}\n`);
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

async function buildServerArtifact(buildArgs, targetRuntime) {
  const [
    sourcePageFile,
    outputFile,
    layoutsJson = "[]",
    documentJson = "null",
    conventionsJson = "{}",
    routePattern,
    cloudflareMetadataJson,
  ] =
    buildArgs;
  if (!sourcePageFile || !outputFile || !routePattern) {
    throw new TypeError(
      `usage: render-page --build-${targetRuntime === "cloudflare" ? "cloudflare-" : ""}artifact <page-file> <output-file> <layouts-json> <document-json> <conventions-json> <route-pattern>`,
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
  const cloudflareMetadata = targetRuntime === "cloudflare"
    ? parseCloudflareMetadata(cloudflareMetadataJson, routePattern)
    : undefined;

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
  const resolvedOutput = resolve(outputFile);

  try {
    if (targetRuntime === "cloudflare") {
      await buildCloudflareServerArtifact({
        artifactProjectRoot,
        cloudflareMetadata,
        conventionFiles: resolvedConventions,
        documentFile: resolvedDocument,
        entryFile,
        excludedFiles,
        layoutFiles: resolvedLayouts,
        outputFile: resolvedOutput,
        pageFile: resolvedPage,
        routePattern,
        tempDir,
      });
    } else {
      await writeFile(
        entryFile,
        serverArtifactEntrySource({
          pageFile: resolvedPage,
          layoutFiles: resolvedLayouts,
          documentFile: resolvedDocument,
          conventionFiles: resolvedConventions,
          routePattern,
          cloudflareMetadata,
        }),
      );
      await mkdir(dirname(resolvedOutput), { recursive: true });
      await bundleServerArtifact({
        entryFile,
        outputFile: resolvedOutput,
        projectRoot: artifactProjectRoot,
        excludedFiles,
        targetRuntime,
      });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildCloudflareServerArtifact({
  artifactProjectRoot,
  cloudflareMetadata,
  conventionFiles,
  documentFile,
  entryFile,
  excludedFiles,
  layoutFiles,
  outputFile,
  pageFile,
  routePattern,
  tempDir,
}) {
  const preliminaryOutput = join(tempDir, "preliminary.mjs");
  const canonicalOutput = join(tempDir, "canonical.mjs");
  const preliminaryMetadata = cloudflareRouteIdentity(
    cloudflareMetadata,
    routePattern,
    ZERO_SHA256_BUILD_ID,
    ZERO_SHA256_BUILD_ID,
  );
  const preliminary = await buildCloudflareArtifactPass({
    cloudflareMetadata: preliminaryMetadata,
    conventionFiles,
    documentFile,
    entryFile,
    excludedFiles,
    layoutFiles,
    outputFile: preliminaryOutput,
    pageFile,
    projectRoot: artifactProjectRoot,
    routePattern,
  });
  const sourceBuildId = digestBuildIdentity({
    format: "ferrite-cloudflare-source",
    version: 1,
    inputs: preliminary.inputs,
  });
  if (
    cloudflareMetadata.claimedSourceBuildId !== undefined &&
    cloudflareMetadata.claimedSourceBuildId !== sourceBuildId
  ) {
    throw new TypeError(
      `Ferrite Cloudflare sourceBuildId is stale: expected ${sourceBuildId}, received ${cloudflareMetadata.claimedSourceBuildId}.`,
    );
  }

  const canonicalMetadata = cloudflareRouteIdentity(
    cloudflareMetadata,
    routePattern,
    sourceBuildId,
    ZERO_SHA256_BUILD_ID,
  );
  const canonical = await buildCloudflareArtifactPass({
    cloudflareMetadata: canonicalMetadata,
    conventionFiles,
    documentFile,
    entryFile,
    excludedFiles,
    layoutFiles,
    outputFile: canonicalOutput,
    pageFile,
    projectRoot: artifactProjectRoot,
    routePattern,
  });
  assertSameCloudflareInputs(preliminary.inputs, canonical.inputs);
  const canonicalModule = await fileIdentity(canonicalOutput);
  const moduleBuildId = `sha256:${canonicalModule.sha256}`;

  const finalMetadata = cloudflareRouteIdentity(
    cloudflareMetadata,
    routePattern,
    sourceBuildId,
    moduleBuildId,
  );
  await mkdir(dirname(outputFile), { recursive: true });
  const final = await buildCloudflareArtifactPass({
    cloudflareMetadata: finalMetadata,
    conventionFiles,
    documentFile,
    entryFile,
    excludedFiles,
    layoutFiles,
    outputFile,
    pageFile,
    projectRoot: artifactProjectRoot,
    routePattern,
  });
  assertSameCloudflareInputs(preliminary.inputs, final.inputs);

  const [canonicalBytes, finalBytes] = await Promise.all([
    readFile(canonicalOutput),
    readFile(outputFile),
  ]);
  const sentinel = Buffer.from(ZERO_SHA256_BUILD_ID);
  const replacement = Buffer.from(moduleBuildId);
  const sentinelOffsets = allBufferOffsets(canonicalBytes, sentinel);
  if (sentinelOffsets.length !== 1) {
    throw new TypeError(
      `Ferrite Cloudflare canonical module must contain exactly one module identity sentinel; found ${sentinelOffsets.length}.`,
    );
  }
  const expectedFinal = Buffer.from(canonicalBytes);
  replacement.copy(expectedFinal, sentinelOffsets[0]);
  if (!expectedFinal.equals(finalBytes)) {
    throw new TypeError(
      "Ferrite Cloudflare final module changed outside its canonical module identity field.",
    );
  }

  const module = await fileIdentity(outputFile);
  const receipt = {
    format: {
      name: CLOUDFLARE_ROUTE_RECEIPT_FORMAT,
      major: 1,
      minor: 0,
    },
    sourceBuildId,
    metadataBuildId: finalMetadata.metadataBuildId,
    moduleBuildId,
    assetBuildId: cloudflareMetadata.assetBuildId,
    path: routePattern,
    fallbackPath: cloudflareMetadata.fallbackPath,
    observedActions: cloudflareMetadata.observedActions,
    compiler: {
      name: "esbuild",
      version: esbuildVersion,
      node: process.version,
      platform: "neutral",
      format: "esm",
      target: "es2022",
      conditions: ["workerd", "worker", "browser", "import", "default"],
      mainFields: ["module", "main"],
      minifyIdentifiers: false,
      minifySyntax: true,
      minifyWhitespace: true,
    },
    inputs: final.inputs,
    canonicalModule,
    module: {
      path: basename(outputFile),
      ...module,
    },
  };
  const receiptPath = `${outputFile}.receipt.json`;
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(receiptPath, receiptBytes);
  await verifyCloudflareArtifactReceipt([outputFile, receiptPath]);
}

async function buildCloudflareArtifactPass({
  cloudflareMetadata,
  conventionFiles,
  documentFile,
  entryFile,
  excludedFiles,
  layoutFiles,
  outputFile,
  pageFile,
  projectRoot,
  routePattern,
}) {
  await writeFile(
    entryFile,
    serverArtifactEntrySource({
      pageFile,
      layoutFiles,
      documentFile,
      conventionFiles,
      routePattern,
      cloudflareMetadata,
    }),
  );
  const inputSnapshot = new Map();
  await bundleServerArtifact({
    entryFile,
    outputFile,
    projectRoot,
    excludedFiles,
    targetRuntime: "cloudflare",
    inputSnapshot,
  });
  await assertCapturedCloudflareInputsUnchanged(inputSnapshot);
  return {
    inputs: await serializeCloudflareInputSnapshot(inputSnapshot, projectRoot, entryFile),
  };
}

async function assertCapturedCloudflareInputsUnchanged(inputSnapshot) {
  for (const [file, captured] of inputSnapshot) {
    const current = await readFile(file);
    if (!captured.equals(current)) {
      throw new TypeError(
        `Ferrite Cloudflare route input changed during bundling: "${file}".`,
      );
    }
  }
}

function serverArtifactEntrySource({
  pageFile,
  layoutFiles,
  documentFile,
  conventionFiles,
  routePattern,
  cloudflareMetadata,
}) {
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
    ...(cloudflareMetadata
      ? [`export const cloudflare = Object.freeze(${JSON.stringify(cloudflareMetadata)});`]
      : []),
    "",
  ].join("\n");
}

function parseCloudflareMetadata(source, routePattern) {
  if (!source) {
    throw new TypeError(
      "Ferrite Cloudflare artifacts require metadata JSON from the validated production manifest.",
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(source);
  } catch (error) {
    throw new TypeError(
      `Ferrite Cloudflare artifact metadata must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Ferrite Cloudflare artifact metadata must be an object.");
  }
  const keys = Object.keys(metadata);
  const expected = new Set([
    "sourceBuildId",
    "assetBuildId",
    "fallbackPath",
    "observedActions",
  ]);
  const unknown = keys.filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Ferrite Cloudflare artifact metadata contains unknown fields: ${unknown.join(", ")}`);
  }
  if (
    metadata.sourceBuildId !== undefined &&
    (typeof metadata.sourceBuildId !== "string" ||
      !SHA256_BUILD_ID.test(metadata.sourceBuildId))
  ) {
    throw new TypeError(
      "Ferrite Cloudflare artifact metadata sourceBuildId must be a SHA-256 build identity when supplied.",
    );
  }
  if (
    typeof metadata.assetBuildId !== "string" ||
    !SHA256_BUILD_ID.test(metadata.assetBuildId)
  ) {
    throw new TypeError(
      "Ferrite Cloudflare artifact metadata assetBuildId must be a SHA-256 build identity.",
    );
  }
  if (
    typeof metadata.fallbackPath !== "string" ||
    !metadata.fallbackPath.startsWith("/") ||
    metadata.fallbackPath.includes("%") ||
    metadata.fallbackPath.includes("\\") ||
    metadata.fallbackPath.includes("\0") ||
    metadata.fallbackPath.includes("?") ||
    metadata.fallbackPath.includes("#") ||
    metadata.fallbackPath.includes("//") ||
    metadata.fallbackPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "Ferrite Cloudflare artifact metadata fallbackPath must be a canonical unencoded absolute asset path.",
    );
  }
  if (
    !Array.isArray(metadata.observedActions) ||
    metadata.observedActions.some((action) => typeof action !== "string" || action.length === 0)
  ) {
    throw new TypeError(
      "Ferrite Cloudflare artifact metadata observedActions must be an array of non-empty strings.",
    );
  }
  if (metadata.observedActions.length > 0) {
    throw new TypeError("Ferrite Cloudflare artifacts do not support routes with observed server actions.");
  }
  return {
    claimedSourceBuildId: metadata.sourceBuildId,
    assetBuildId: metadata.assetBuildId,
    fallbackPath: metadata.fallbackPath,
    observedActions: metadata.observedActions,
  };
}

function cloudflareRouteIdentity(
  metadata,
  routePattern,
  sourceBuildId,
  moduleBuildId,
) {
  const identity = {
    format: "ferrite-cloudflare-route",
    version: 2,
    sourceBuildId,
    assetBuildId: metadata.assetBuildId,
    path: routePattern,
    fallbackPath: metadata.fallbackPath,
    observedActions: metadata.observedActions,
  };
  return {
    ...identity,
    metadataBuildId: cloudflareRouteMetadataBuildId(identity),
    moduleBuildId,
  };
}

function cloudflareRouteMetadataBuildId({
  format,
  version,
  sourceBuildId,
  assetBuildId,
  path,
  fallbackPath,
  observedActions,
}) {
  return digestBuildIdentity({
    format: "ferrite-cloudflare-route-metadata",
    version: 1,
    route: {
      format,
      version,
      sourceBuildId,
      assetBuildId,
      path,
      fallbackPath,
      observedActions,
    },
  });
}

async function bundleServerArtifact({
  entryFile,
  outputFile,
  projectRoot,
  excludedFiles,
  targetRuntime = "node",
  inputSnapshot,
}) {
  const cloudflare = targetRuntime === "cloudflare";
  const result = await build({
    entryPoints: [entryFile],
    outfile: outputFile,
    bundle: true,
    platform: cloudflare ? "neutral" : "node",
    format: "esm",
    target: cloudflare ? "es2022" : "node22",
    ...(cloudflare
      ? {
          conditions: ["workerd", "worker", "browser", "import", "default"],
          mainFields: ["module", "main"],
          minifyIdentifiers: false,
          minifySyntax: true,
          minifyWhitespace: true,
        }
      : { minify: true }),
    jsx: "automatic",
    jsxImportSource: "@ferrite/runtime",
    plugins: [
      clientReferenceProxyPlugin({ projectRoot, excludedFiles, inputSnapshot }),
      ...(cloudflare
        ? [
            cloudflareBuiltinGuardPlugin(),
            cloudflareInputSnapshotPlugin({
              inputSnapshot,
              projectRoot,
            }),
          ]
        : []),
    ],
    loader: {
      ".css": "empty",
    },
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });
  const unsupportedExternals = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((item) =>
      item.external &&
      (cloudflare ? item.path !== "node:async_hooks" : !isBuiltin(item.path))
    )
    .map((item) => item.path);
  if (unsupportedExternals.length > 0) {
    throw new TypeError(
      `Ferrite ${cloudflare ? "Cloudflare " : ""}server artifacts cannot depend on unsupported external packages: ${[...new Set(unsupportedExternals)].sort().join(", ")}`,
    );
  }
  return result;
}

function cloudflareBuiltinGuardPlugin() {
  return {
    name: "ferrite-cloudflare-builtin-guard",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isBuiltin(args.path)) {
          return undefined;
        }
        const importer = args.importer.replaceAll("\\", "/");
        const runtimeAsyncContext =
          args.path === "node:async_hooks" &&
          /(?:^|\/)(?:packages\/runtime|node_modules\/@ferrite\/runtime)\/(?:src|dist)\/server\.(?:ts|js)$/.test(
            importer,
          );
        if (runtimeAsyncContext) {
          return { path: args.path, external: true };
        }
        return {
          errors: [
            {
              text: `Ferrite Cloudflare server artifacts cannot import Node builtin "${args.path}" from "${importer || "<entry>"}".`,
            },
          ],
        };
      });
    },
  };
}

function cloudflareInputSnapshotPlugin({ inputSnapshot, projectRoot }) {
  return {
    name: "ferrite-cloudflare-input-snapshot",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const file = await realSourcePath(args.path);
        const contents = await readFile(file);
        recordCloudflareInput(inputSnapshot, file, contents);
        const extension = extname(file);
        if (extension === ".css") {
          return {
            contents: "",
            loader: "css",
            resolveDir: dirname(file),
          };
        }
        if (extension === ".json") {
          return {
            contents,
            loader: "json",
            resolveDir: dirname(file),
          };
        }
        if (!/\.[cm]?[jt]sx?$/.test(extension)) {
          throw new TypeError(
            `Ferrite Cloudflare route input "${portablePath(file, projectRoot)}" uses unsupported extension "${extension || "<none>"}".`,
          );
        }
        return {
          contents,
          loader: loaderForPath(file),
          resolveDir: dirname(file),
        };
      });
    },
  };
}

function clientReferenceProxyPlugin({ projectRoot, excludedFiles, inputSnapshot }) {
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

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "ferrite-client-original" }, async (args) => {
        const contents = await readFile(args.path);
        recordCloudflareInput(inputSnapshot, await realSourcePath(args.path), contents);
        return {
          contents,
          loader: loaderForPath(args.path),
          resolveDir: dirname(args.path),
        };
      });

      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        const file = await realSourcePath(args.path);
        if (excludedFiles.has(file) || !isProjectSource(file, projectRoot)) {
          return undefined;
        }

        const sourceBytes = await readFile(file);
        recordCloudflareInput(inputSnapshot, file, sourceBytes);
        const source = sourceBytes.toString("utf8");
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

function recordCloudflareInput(inputSnapshot, file, contents) {
  if (!inputSnapshot) {
    return;
  }
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const previous = inputSnapshot.get(file);
  if (previous && !previous.equals(bytes)) {
    throw new TypeError(
      `Ferrite Cloudflare route input changed while esbuild was reading "${file}".`,
    );
  }
  inputSnapshot.set(file, Buffer.from(bytes));
}

async function serializeCloudflareInputSnapshot(inputSnapshot, projectRoot, entryFile) {
  const [canonicalProjectRoot, canonicalEntry, ferritePackageRoots] = await Promise.all([
    realSourcePath(projectRoot),
    realSourcePath(entryFile),
    cloudflareReceiptPackageRoots(),
  ]);
  const records = [];
  for (const [file, contents] of inputSnapshot) {
    const canonicalFile = await realSourcePath(file);
    if (canonicalFile === canonicalEntry) {
      continue;
    }
    let path;
    const ferritePackage = ferritePackageRoots.find(({ root }) =>
      isPathInside(root, canonicalFile)
    );
    if (ferritePackage) {
      const packageRelative = portableRelativePath(ferritePackage.root, canonicalFile);
      if (
        !packageRelative.startsWith(ferritePackage.allowedPrefix) ||
        !isCanonicalReceiptRelativePath(packageRelative)
      ) {
        throw new TypeError(
          `Ferrite Cloudflare route imported unsupported ${ferritePackage.name} input "${packageRelative || "<package-root>"}".`,
        );
      }
      path = `${ferritePackage.name}/${packageRelative}`;
    } else if (isPathInside(canonicalProjectRoot, canonicalFile)) {
      const projectRelative = portableRelativePath(canonicalProjectRoot, canonicalFile);
      if (!isCanonicalReceiptRelativePath(projectRelative)) {
        throw new TypeError(
          `Ferrite Cloudflare route imported non-canonical project input "${projectRelative}".`,
        );
      }
      if (hasGeneratedSourceSegment(projectRelative)) {
        throw new TypeError(
          `Ferrite Cloudflare route imported excluded generated source "${projectRelative}".`,
        );
      }
      path = `project/${projectRelative}`;
    } else {
      throw new TypeError(
        `Ferrite Cloudflare route imported source outside the project and Ferrite package roots: "${canonicalFile}".`,
      );
    }
    records.push({
      path,
      bytes: contents.byteLength,
      sha256: sha256Hex(contents),
    });
  }
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const duplicate = records.find((record, index) =>
    index > 0 && records[index - 1].path === record.path
  );
  if (duplicate) {
    throw new TypeError(
      `Ferrite Cloudflare route input manifest contains duplicate path "${duplicate.path}".`,
    );
  }
  if (records.length === 0) {
    throw new TypeError("Ferrite Cloudflare route input manifest is empty.");
  }
  return records;
}

async function cloudflareReceiptPackageRoots() {
  const roots = await Promise.all(CLOUDFLARE_RECEIPT_PACKAGES.map((descriptor) =>
    verifiedPackageRoot(
      descriptor,
      descriptor.name === "@ferrite/runtime"
        ? fileURLToPath(import.meta.url)
        : requireFromRuntime.resolve(descriptor.name),
    )
  ));
  const seen = new Set();
  for (const { name, root } of roots) {
    if (seen.has(root)) {
      throw new TypeError(
        `Ferrite Cloudflare receipt packages resolve to the same canonical root: "${root}" (${name}).`,
      );
    }
    seen.add(root);
  }
  return roots.sort((left, right) =>
    right.root.length - left.root.length ||
    Buffer.from(left.name).compare(Buffer.from(right.name))
  );
}

async function verifiedPackageRoot(descriptor, entryFile) {
  const root = await realSourcePath(await findNearestPackageRoot(entryFile));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new TypeError(
      `Ferrite Cloudflare receipt root for "${descriptor.name}" has an unreadable package manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest?.name !== descriptor.name) {
    throw new TypeError(
      `Ferrite Cloudflare receipt root for "${descriptor.name}" resolved to package "${String(manifest?.name ?? "<missing>")}".`,
    );
  }
  return { ...descriptor, root };
}

function assertSameCloudflareInputs(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new TypeError(
      "Ferrite Cloudflare route inputs changed between identity capture and final bundling.",
    );
  }
}

function isPathInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function portableRelativePath(root, candidate) {
  return relative(root, candidate).split(sep).join("/");
}

function isCanonicalReceiptRelativePath(path) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    )
  );
}

function isCloudflareReceiptInputPath(path) {
  const projectPrefix = "project/";
  if (path.startsWith(projectPrefix)) {
    const projectRelative = path.slice(projectPrefix.length);
    return (
      isCanonicalReceiptRelativePath(projectRelative) &&
      !hasGeneratedSourceSegment(projectRelative)
    );
  }
  return CLOUDFLARE_RECEIPT_PACKAGES.some(({ name, allowedPrefix }) => {
    const packagePrefix = `${name}/`;
    if (!path.startsWith(packagePrefix)) {
      return false;
    }
    const packageRelative = path.slice(packagePrefix.length);
    return (
      packageRelative.startsWith(allowedPrefix) &&
      isCanonicalReceiptRelativePath(packageRelative)
    );
  });
}

function portablePath(file, projectRoot) {
  return isPathInside(projectRoot, file)
    ? portableRelativePath(projectRoot, file)
    : file.split(sep).join("/");
}

function hasGeneratedSourceSegment(path) {
  return path.split("/").some((segment) =>
    segment === ".git" ||
    segment === ".ferrite" ||
    segment === "node_modules" ||
    segment === "target" ||
    segment.startsWith(".ferrite-build-") ||
    segment.startsWith(".ferrite-verified-build-")
  );
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

function digestBuildIdentity(value) {
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(value)))}`;
}

function sha256Hex(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function fileIdentity(path) {
  const contents = await readFile(path);
  return {
    bytes: contents.byteLength,
    sha256: sha256Hex(contents),
  };
}

function allBufferOffsets(buffer, needle) {
  const offsets = [];
  let offset = 0;
  while (offset <= buffer.byteLength - needle.byteLength) {
    const found = buffer.indexOf(needle, offset);
    if (found === -1) {
      break;
    }
    offsets.push(found);
    offset = found + needle.byteLength;
  }
  return offsets;
}

async function verifyCloudflareArtifactReceipt(buildArgs) {
  const [artifactFile, receiptFile = artifactFile ? `${artifactFile}.receipt.json` : undefined] =
    buildArgs;
  if (!artifactFile || !receiptFile) {
    throw new TypeError(
      "usage: render-page --verify-cloudflare-artifact-receipt <artifact-file> [receipt-file]",
    );
  }
  const [artifactBytes, receiptBytes] = await Promise.all([
    readFile(resolve(artifactFile)),
    readFile(resolve(receiptFile)),
  ]);
  const artifact = {
    bytes: artifactBytes.byteLength,
    sha256: sha256Hex(artifactBytes),
  };
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    throw new TypeError("Ferrite Cloudflare route receipt is not valid JSON.");
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.format?.name !== CLOUDFLARE_ROUTE_RECEIPT_FORMAT ||
    receipt.format?.major !== 1 ||
    receipt.format?.minor !== 0 ||
    !SHA256_BUILD_ID.test(receipt.sourceBuildId ?? "") ||
    !SHA256_BUILD_ID.test(receipt.metadataBuildId ?? "") ||
    !SHA256_BUILD_ID.test(receipt.moduleBuildId ?? "") ||
    !SHA256_BUILD_ID.test(receipt.assetBuildId ?? "") ||
    !receipt.module ||
    typeof receipt.module !== "object" ||
    Array.isArray(receipt.module) ||
    receipt.module.path !== basename(resolve(artifactFile)) ||
    !Number.isSafeInteger(receipt.module.bytes) ||
    receipt.module.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.module.sha256 ?? "") ||
    !receipt.canonicalModule ||
    typeof receipt.canonicalModule !== "object" ||
    Array.isArray(receipt.canonicalModule) ||
    !Number.isSafeInteger(receipt.canonicalModule.bytes) ||
    receipt.canonicalModule.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.canonicalModule.sha256 ?? "") ||
    typeof receipt.path !== "string" ||
    !receipt.path.startsWith("/") ||
    typeof receipt.fallbackPath !== "string" ||
    !receipt.fallbackPath.startsWith("/") ||
    !Array.isArray(receipt.observedActions) ||
    receipt.observedActions.length !== 0 ||
    receipt.compiler?.name !== "esbuild" ||
    receipt.compiler?.version !== esbuildVersion ||
    receipt.compiler?.node !== process.version ||
    receipt.compiler?.platform !== "neutral" ||
    receipt.compiler?.format !== "esm" ||
    receipt.compiler?.target !== "es2022" ||
    JSON.stringify(receipt.compiler?.conditions) !==
      JSON.stringify(["workerd", "worker", "browser", "import", "default"]) ||
    JSON.stringify(receipt.compiler?.mainFields) !==
      JSON.stringify(["module", "main"]) ||
    receipt.compiler?.minifyIdentifiers !== false ||
    receipt.compiler?.minifySyntax !== true ||
    receipt.compiler?.minifyWhitespace !== true ||
    !Array.isArray(receipt.inputs)
  ) {
    throw new TypeError("Ferrite Cloudflare route receipt has an invalid schema.");
  }
  const inputPaths = new Set();
  for (const input of receipt.inputs) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.path !== "string" ||
      !isCloudflareReceiptInputPath(input.path) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(input.sha256 ?? "") ||
      inputPaths.has(input.path)
    ) {
      throw new TypeError("Ferrite Cloudflare route receipt has an invalid input manifest.");
    }
    inputPaths.add(input.path);
  }
  const sortedInputs = [...receipt.inputs].sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path))
  );
  if (JSON.stringify(sortedInputs) !== JSON.stringify(receipt.inputs)) {
    throw new TypeError("Ferrite Cloudflare route receipt input manifest is not canonical.");
  }
  if (
    artifact.bytes !== receipt.module.bytes ||
    artifact.sha256 !== receipt.module.sha256
  ) {
    throw new TypeError("Ferrite Cloudflare route module does not match its receipt.");
  }
  const expectedSourceBuildId = digestBuildIdentity({
    format: "ferrite-cloudflare-source",
    version: 1,
    inputs: receipt.inputs,
  });
  if (receipt.sourceBuildId !== expectedSourceBuildId) {
    throw new TypeError("Ferrite Cloudflare route receipt source identity is invalid.");
  }
  const expectedMetadataBuildId = cloudflareRouteMetadataBuildId({
    format: "ferrite-cloudflare-route",
    version: 2,
    sourceBuildId: receipt.sourceBuildId,
    assetBuildId: receipt.assetBuildId,
    path: receipt.path,
    fallbackPath: receipt.fallbackPath,
    observedActions: receipt.observedActions,
  });
  if (receipt.metadataBuildId !== expectedMetadataBuildId) {
    throw new TypeError("Ferrite Cloudflare route receipt metadata identity is invalid.");
  }
  if (allBufferOffsets(artifactBytes, Buffer.from(receipt.metadataBuildId)).length !== 1) {
    throw new TypeError(
      "Ferrite Cloudflare route module does not contain exactly one receipt metadata identity.",
    );
  }
  if (receipt.moduleBuildId !== `sha256:${receipt.canonicalModule?.sha256 ?? ""}`) {
    throw new TypeError("Ferrite Cloudflare route receipt canonical module identity is invalid.");
  }
  const moduleIdentity = Buffer.from(receipt.moduleBuildId);
  const moduleIdentityOffsets = allBufferOffsets(artifactBytes, moduleIdentity);
  if (moduleIdentityOffsets.length !== 1) {
    throw new TypeError(
      "Ferrite Cloudflare route module does not contain exactly one canonical module identity.",
    );
  }
  const reconstructedCanonical = Buffer.from(artifactBytes);
  Buffer.from(ZERO_SHA256_BUILD_ID).copy(
    reconstructedCanonical,
    moduleIdentityOffsets[0],
  );
  if (
    reconstructedCanonical.byteLength !== receipt.canonicalModule.bytes ||
    sha256Hex(reconstructedCanonical) !== receipt.canonicalModule.sha256
  ) {
    throw new TypeError(
      "Ferrite Cloudflare route module cannot be reconstructed from its canonical receipt.",
    );
  }
  return {
    status: "verified",
    artifact: {
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    receipt: {
      bytes: receiptBytes.byteLength,
      sha256: sha256Hex(receiptBytes),
      sourceBuildId: receipt.sourceBuildId,
      metadataBuildId: receipt.metadataBuildId,
      moduleBuildId: receipt.moduleBuildId,
      assetBuildId: receipt.assetBuildId,
      path: receipt.path,
    },
  };
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
