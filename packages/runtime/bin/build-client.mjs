#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import ts from "typescript";

import { isPathInsideRoot } from "./project-path.mjs";

const [, , pageFile, outDirArg, publicPathArg, routePath = "/", propsJson = "{}", layoutsJson = "[]", optionsJson = "{}"] =
  process.argv;

if (!pageFile || !outDirArg || !publicPathArg) {
  console.error(
    "usage: build-client <page-file> <out-dir> <public-path> [route-path] [props-json] [layouts-json] [options-json]",
  );
  process.exit(2);
}

let props;
let layoutFiles;
let options;
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
try {
  options = JSON.parse(optionsJson);
} catch (error) {
  console.error(`invalid options JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!Array.isArray(layoutFiles) || layoutFiles.some((file) => typeof file !== "string")) {
  console.error("layouts JSON must be an array of file paths");
  process.exit(2);
}
if (!options || typeof options !== "object" || Array.isArray(options)) {
  console.error("options JSON must be an object");
  process.exit(2);
}

const projectRoot = await realpath(await findNearestPackageRoot(resolve(pageFile)));
const runtimeSrcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const outDir = resolve(outDirArg);
const publicPath = publicPathArg.replace(/\/$/, "");
const entryName = routeToEntryName(routePath);
const fileLoaders = {
  ".png": "file",
  ".jpg": "file",
  ".jpeg": "file",
  ".gif": "file",
  ".svg": "file",
  ".webp": "file",
  ".woff": "file",
  ".woff2": "file",
  ".wasm": "file",
};
const extensionlessSourceExtensions = [".tsx", ".ts", ".jsx", ".js"];
const sourceExtensions = [...extensionlessSourceExtensions, ".mts", ".cts", ".mjs", ".cjs"];
const emittedSourceSubstitutions = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);
await mkdir(outDir, { recursive: true });

const routeFiles = [pageFile, ...layoutFiles];
const maxStableBuildAttempts = 2;
let response;

for (let attempt = 1; attempt <= maxStableBuildAttempts; attempt += 1) {
  const graphCompiler = await loadGraphCompilerOptions(projectRoot);
  const moduleGraph = await collectClientReferences(
    routeFiles,
    projectRoot,
    graphCompiler.options,
    graphCompiler.sources,
  );
  response = (await routeHasClientDirective(routeFiles))
    ? await bundleClientRoute(moduleGraph)
    : await bundleServerRoute(moduleGraph);

  if (await moduleGraphSnapshotIsCurrent(moduleGraph.snapshot, projectRoot)) {
    break;
  }
  response = undefined;
}

if (!response) {
  throw new Error(
    `Ferrite module graph inputs changed during ${maxStableBuildAttempts} consecutive client builds; retry after the source tree is stable.`,
  );
}
await writeResponse(response);

async function bundleServerRoute(moduleGraph) {
  const referenceBundles = await bundleClientReferences(moduleGraph.references, projectRoot, outDir, publicPath);
  const actionBootstrap =
    options.actionBootstrap === true && referenceBundles.clientReferences.length === 0
      ? await bundleActionBootstrap(entryName, projectRoot, outDir, publicPath)
      : null;
  return {
    script: null,
    actionBootstrap: actionBootstrap?.script,
    styles: [],
    outputs: mergeSorted(referenceBundles.outputs, actionBootstrap?.outputs ?? []),
    sourcemaps: mergeSorted(referenceBundles.sourcemaps, actionBootstrap?.sourcemaps ?? []),
    assets: mergeSorted(referenceBundles.assets, actionBootstrap?.assets ?? []),
    clientReferences: referenceBundles.clientReferences,
    moduleGraph: moduleGraph.nodes,
    hydration: "server",
  };
}

async function bundleClientRoute(moduleGraph) {
  const tempRoot = join(projectRoot, ".ferrite", "tmp");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "client-"));
  const entryFile = join(tempDir, `${entryName}.tsx`);

  try {
    await writeFile(
      entryFile,
      [
        `import { createElement } from "@ferrite/runtime";`,
        `import { bootstrapServerActionForms, hydrate } from "@ferrite/runtime/dom";`,
        `import Page from ${JSON.stringify(resolve(pageFile))};`,
        ...layoutFiles.map((file, index) => `import Layout${index} from ${JSON.stringify(resolve(file))};`),
        "",
        `const layouts = [${layoutFiles.map((_file, index) => `Layout${index}`).join(", ")}];`,
        `const root = document.getElementById("ferrite-root") || document.getElementById("ferrite-dev-root");`,
        ...(options.runtimeProps === true
          ? [
              `const serializedProps = root?.getAttribute("data-ferrite-page-props");`,
              `if (!serializedProps) {`,
              `  throw new TypeError("Ferrite production hydration requires data-ferrite-page-props.");`,
              `}`,
              `const pageProps = JSON.parse(serializedProps);`,
            ]
          : [`const pageProps = ${JSON.stringify(props)};`]),
        `const page = createElement(Page, pageProps);`,
        `const tree = layouts.reduceRight((child, Layout) => createElement(Layout, { children: child }), page);`,
        `if (root) {`,
        `  hydrate(tree, root);`,
        `}`,
        `if (typeof document !== "undefined") {`,
        `  bootstrapServerActionForms(document);`,
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
      publicPath,
      sourcemap: true,
      metafile: true,
      jsx: "automatic",
      jsxImportSource: "@ferrite/runtime",
      plugins: [ferriteRuntimeAliasPlugin()],
      loader: fileLoaders,
      logLevel: "silent",
    });
    const summary = summarizeBuildResult(result, outDir, entryFile, publicPath);
    return {
      script: summary.script,
      styles: summary.styles,
      outputs: summary.outputs,
      sourcemaps: summary.sourcemaps,
      assets: summary.assets,
      clientReferences: [],
      moduleGraph: moduleGraph.nodes,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

async function bundleActionBootstrap(routeEntryName, projectRoot, outDir, publicPath) {
  const tempRoot = join(projectRoot, ".ferrite", "tmp");
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "action-bootstrap-"));
  const entryName = `${routeEntryName}-action-bootstrap`;
  const entryFile = join(tempDir, `${entryName}.ts`);

  try {
    await writeFile(
      entryFile,
      [
        `import { bootstrapServerActionForms } from "@ferrite/runtime/dom";`,
        `if (typeof document !== "undefined") {`,
        `  bootstrapServerActionForms(document);`,
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
      publicPath,
      sourcemap: true,
      metafile: true,
      plugins: [ferriteRuntimeAliasPlugin()],
      loader: fileLoaders,
      logLevel: "silent",
    });
    return summarizeBuildResult(result, outDir, entryFile, publicPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function mergeSorted(...lists) {
  return [...new Set(lists.flat())].sort(compareDeterministicStrings);
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
      publicPath,
      sourcemap: true,
      metafile: true,
      jsx: "automatic",
      jsxImportSource: "@ferrite/runtime",
      plugins: [ferriteRuntimeAliasPlugin()],
      loader: fileLoaders,
      logLevel: "silent",
    });
    return summarizeBuildResult(result, outDir, entryFile, publicPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function clientReferenceEntrySource(clientReference) {
  return [
    `import { bootstrapServerActionForms, hydrateClientReference } from "@ferrite/runtime/dom";`,
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
    `  bootstrapServerActionForms(document);`,
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

async function collectClientReferences(entryFiles, projectRoot, compilerOptions, compilerSources) {
  const references = new Map();
  const graph = new Map();
  const visiting = [];
  const visited = new Set();
  const snapshot = {
    sources: new Map(compilerSources),
    resolutions: new Map(),
    unstable: false,
  };
  const compilerWatchFiles = [...compilerSources.keys()]
    .filter((file) => isPathInsideRoot(projectRoot, file))
    .map((file) => relative(projectRoot, file).split(sep).join("/"))
    .sort(compareDeterministicStrings);

  for (const entryFile of [...entryFiles].sort(compareDeterministicStrings)) {
    const resolution = await resolveSourceFile(resolve(entryFile), projectRoot, snapshot);
    const resolved = resolution.file;
    if (resolved) {
      if (!isProjectModule(resolved, projectRoot)) {
        throw new Error(`Ferrite module graph entry escapes the project root: ${relative(projectRoot, resolved).split(sep).join("/")}`);
      }
      await scanServerFileForClientReferences(
        resolved,
        projectRoot,
        graph,
        visiting,
        visited,
        references,
        compilerOptions,
        snapshot,
        false,
        mergeSorted(compilerWatchFiles, portableWatchCandidates(resolution, projectRoot)),
      );
    }
  }

  return {
    references: [...references.values()].sort((left, right) => compareDeterministicStrings(left.id, right.id)),
    nodes: [...graph.entries()]
      .map(([file, node]) => {
        const serialized = {
          file: relative(projectRoot, file).split(sep).join("/"),
          imports: node.imports.map((entry) => relative(projectRoot, entry).split(sep).join("/")),
        };
        if (node.watchFiles.length > 0) {
          serialized.watchFiles = node.watchFiles;
        }
        return serialized;
      })
      .sort((left, right) => compareDeterministicStrings(left.file, right.file)),
    snapshot,
  };
}

async function scanServerFileForClientReferences(
  file,
  projectRoot,
  graph,
  visiting,
  visited,
  references,
  compilerOptions,
  snapshot,
  inheritedClientSubtree = false,
  initialWatchFiles = [],
) {
  const resolvedFile = resolve(file);
  const cycleStart = visiting.indexOf(resolvedFile);
  if (cycleStart !== -1) {
    const cycle = [...visiting.slice(cycleStart), resolvedFile]
      .map((entry) => relative(projectRoot, entry).split(sep).join("/"))
      .join(" -> ");
    throw new Error(`Ferrite module graph cycle: ${cycle}`);
  }

  const graphNode = graph.get(resolvedFile) ?? { imports: [], watchFiles: [] };
  graphNode.watchFiles = mergeSorted(graphNode.watchFiles, initialWatchFiles);
  graph.set(resolvedFile, graphNode);

  const source = await readFile(resolvedFile, "utf8");
  recordSnapshotValue(snapshot.sources, resolvedFile, sha256(source), snapshot);
  const clientSubtree = inheritedClientSubtree || startsWithDirective(source, "use client");
  const visitKey = `${clientSubtree ? "client" : "server"}\0${resolvedFile}`;
  if (visited.has(visitKey)) {
    return;
  }
  visiting.push(resolvedFile);

  const imports = [];
  const watchFiles = [...graphNode.watchFiles];
  for (const importRecord of parseRelativeImportRecords(source, resolvedFile, compilerOptions).sort((left, right) => compareDeterministicStrings(left.specifier, right.specifier))) {
    const resolution = await resolveSourceFile(
      resolve(dirname(resolvedFile), importRecord.specifier),
      projectRoot,
      snapshot,
    );
    const importedFile = resolution.file;
    if (!importedFile) {
      const owner = relative(projectRoot, resolvedFile).split(sep).join("/");
      throw new Error(`Ferrite module graph could not resolve ${JSON.stringify(importRecord.specifier)} from ${owner}`);
    }
    if (!isProjectModule(importedFile, projectRoot)) {
      const owner = relative(projectRoot, resolvedFile).split(sep).join("/");
      throw new Error(`Ferrite module graph import escapes the project root: ${JSON.stringify(importRecord.specifier)} from ${owner}`);
    }
    imports.push(importedFile);
    watchFiles.push(...portableWatchCandidates(resolution, projectRoot));

    const importedSource = await readFile(importedFile, "utf8");
    recordSnapshotValue(snapshot.sources, importedFile, sha256(importedSource), snapshot);
    const importedIsClientModule = startsWithDirective(importedSource, "use client");
    if (!clientSubtree && importedIsClientModule) {
      if (importRecord.exportNames.length === 0 || importRecord.exportNames.includes("*")) {
        const owner = relative(projectRoot, resolvedFile).split(sep).join("/");
        throw new Error(
          `Ferrite client boundary ${JSON.stringify(importRecord.specifier)} from ${owner} must use concrete default or named imports/exports; namespace, side-effect, require, import-equals, and dynamic imports are unsupported across a \"use client\" boundary.`,
        );
      }
      for (const exportName of importRecord.exportNames) {
        const module = relative(projectRoot, importedFile).split(sep).join("/");
        const id = `${module}#${exportName}`;
        references.set(id, { id, module, exportName, file: importedFile });
      }
    }

    await scanServerFileForClientReferences(
      importedFile,
      projectRoot,
      graph,
      visiting,
      visited,
      references,
      compilerOptions,
      snapshot,
      clientSubtree || importedIsClientModule,
    );
  }
  graphNode.imports = [...new Set(imports)].sort(compareDeterministicStrings);
  graphNode.watchFiles = [...new Set(watchFiles)].sort(compareDeterministicStrings);
  visiting.pop();
  visited.add(visitKey);
}

function compareDeterministicStrings(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function recordSnapshotValue(values, key, value, snapshot) {
  const existing = values.get(key);
  if (existing !== undefined && existing !== value) {
    snapshot.unstable = true;
  }
  values.set(key, value);
}

async function moduleGraphSnapshotIsCurrent(snapshot, projectRoot) {
  if (snapshot.unstable) {
    return false;
  }

  for (const [file, expected] of snapshot.sources) {
    try {
      if (sha256(await readFile(file)) !== expected) {
        return false;
      }
    } catch (_error) {
      return false;
    }
  }
  for (const [candidate, expected] of snapshot.resolutions) {
    if ((await describeResolutionCandidate(candidate, projectRoot)) !== expected) {
      return false;
    }
  }
  return true;
}

async function loadGraphCompilerOptions(projectRoot) {
  const configPath = join(projectRoot, "tsconfig.json");
  try {
    await access(configPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { options: {}, sources: new Map() };
    }
    throw error;
  }

  const sources = new Map();
  const readConfigFile = (file) => {
    const source = ts.sys.readFile(file);
    if (source !== undefined) {
      sources.set(resolve(file), sha256(source));
    }
    return source;
  };
  const config = ts.readConfigFile(configPath, readConfigFile);
  if (config.error) {
    throw new Error(`Ferrite module graph could not read tsconfig.json: ${formatTypeScriptDiagnostics([config.error])}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readFile: readConfigFile },
    projectRoot,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(`Ferrite module graph could not load tsconfig.json: ${formatTypeScriptDiagnostics(parsed.errors)}`);
  }
  return {
    options: {
      verbatimModuleSyntax: parsed.options.verbatimModuleSyntax === true,
    },
    sources,
  };
}

function formatTypeScriptDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
    .join("; ");
}

function isProjectModule(file, projectRoot) {
  return isPathInsideRoot(projectRoot, file);
}

function parseRelativeImportRecords(source, fileName, compilerOptions) {
  const records = [];
  const runtimeSource = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.Preserve,
      target: ts.ScriptTarget.Latest,
      verbatimModuleSyntax: compilerOptions.verbatimModuleSyntax === true,
    },
    fileName,
  }).outputText;
  const sourceFile = ts.createSourceFile(fileName, runtimeSource, ts.ScriptTarget.Latest, true);
  let sourceBound = false;

  const requireIsUnbound = (identifier) => {
    if (!sourceBound) {
      ts.bindSourceFile(sourceFile, {
        allowJs: true,
        module: ts.ModuleKind.Preserve,
        target: ts.ScriptTarget.Latest,
      });
      sourceBound = true;
    }
    return isUnboundRequire(identifier);
  };

  const addRecord = (specifier, exportNames) => {
    if (isRelativeSpecifier(specifier) && isSourceSpecifier(specifier)) {
      records.push({ specifier, exportNames });
    }
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && importDeclarationHasRuntimeEffect(node.importClause)
    ) {
      addRecord(node.moduleSpecifier.text, importedExportNames(node.importClause));
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addRecord(node.moduleReference.expression.text, []);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !node.isTypeOnly) {
      const exportNames = exportedNames(node.exportClause);
      if (exportDeclarationHasRuntimeEffect(node.exportClause, exportNames)) {
        addRecord(node.moduleSpecifier.text, exportNames);
      }
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      addRecord(node.arguments[0].text, []);
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && requireIsUnbound(node.expression)
      && node.arguments.length === 1
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      addRecord(node.arguments[0].text, []);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return records;
}

function isUnboundRequire(identifier) {
  let current = identifier.parent;
  while (current) {
    if (current.locals?.has("require")) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function importedExportNames(importClause) {
  const names = [];
  if (importClause?.name) {
    names.push("default");
  }
  if (importClause?.namedBindings) {
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      names.push("*");
    } else {
      names.push(
        ...importClause.namedBindings.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text),
      );
    }
  }
  return names;
}

function importDeclarationHasRuntimeEffect(importClause) {
  if (!importClause) {
    return true;
  }
  if (importClause.isTypeOnly) {
    return false;
  }
  if (importClause.name || !importClause.namedBindings || ts.isNamespaceImport(importClause.namedBindings)) {
    return true;
  }
  return importClause.namedBindings.elements.length === 0
    || importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportedNames(exportClause) {
  if (!exportClause || ts.isNamespaceExport(exportClause)) {
    return ["*"];
  }
  return exportClause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
}

function exportDeclarationHasRuntimeEffect(exportClause, exportNames) {
  return !exportClause
    || ts.isNamespaceExport(exportClause)
    || exportClause.elements.length === 0
    || exportNames.length > 0;
}

function isSourceSpecifier(specifier) {
  const extension = extname(specifier);
  return !extension || sourceExtensions.includes(extension);
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

async function resolveSourceFile(path, projectRoot, snapshot) {
  const extension = extname(path);
  const candidates = extension
    ? [
        path,
        ...(emittedSourceSubstitutions.get(extension) ?? []).map(
          (candidateExtension) => `${path.slice(0, -extension.length)}${candidateExtension}`,
        ),
      ]
    : [
        ...extensionlessSourceExtensions.map((extension) => `${path}${extension}`),
        ...extensionlessSourceExtensions.map((extension) => join(path, `index${extension}`)),
      ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await access(candidate);
      const file = await realpath(candidate);
      const checkedCandidates = candidates.slice(0, index + 1);
      await recordResolutionSnapshot(checkedCandidates, projectRoot, snapshot);
      return { file, candidates: checkedCandidates };
    } catch (_error) {
      // Try the next source-file candidate.
    }
  }

  await recordResolutionSnapshot(candidates, projectRoot, snapshot);
  return { file: null, candidates };
}

async function recordResolutionSnapshot(candidates, projectRoot, snapshot) {
  for (const candidate of candidates) {
    recordSnapshotValue(
      snapshot.resolutions,
      candidate,
      await describeResolutionCandidate(candidate, projectRoot),
      snapshot,
    );
  }
}

async function describeResolutionCandidate(candidate, projectRoot) {
  try {
    const resolved = await realpath(candidate);
    if (!isPathInsideRoot(projectRoot, resolved)) {
      return "outside-project";
    }
    return `resolved:${relative(projectRoot, resolved).split(sep).join("/")}`;
  } catch (error) {
    if (error && typeof error === "object" && typeof error.code === "string") {
      return `error:${error.code}`;
    }
    return "error:unknown";
  }
}

function portableWatchCandidates(resolution, projectRoot) {
  return resolution.candidates
    .filter((candidate) => isPathInsideRoot(projectRoot, candidate))
    .filter((candidate) => resolve(candidate) !== resolution.file)
    .map((candidate) => relative(projectRoot, candidate).split(sep).join("/"))
    .sort(compareDeterministicStrings);
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
