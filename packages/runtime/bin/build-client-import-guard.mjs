import { access, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import ts from "typescript";

const extensionlessSourceExtensions = [".tsx", ".ts", ".jsx", ".js"];
const sourceExtensions = [...extensionlessSourceExtensions, ".mts", ".cts", ".mjs", ".cjs"];
const emittedSourceSubstitutions = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);
const defaultCompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
  resolvePackageJsonExports: true,
  resolvePackageJsonImports: true,
  target: ts.ScriptTarget.Latest,
};

export async function assertBuildClientImportContract(args) {
  const [pageFile, , , , , layoutsJson = "[]", optionsJson = "{}"] = args;
  if (!pageFile) {
    return;
  }

  const layoutFiles = parseOptionalJsonArray(layoutsJson);
  const options = parseOptionalJsonObject(optionsJson);
  if (!layoutFiles || !options) {
    return;
  }
  const snapshotFiles = Array.isArray(options.snapshotFiles)
    ? options.snapshotFiles.filter((file) => typeof file === "string")
    : [];
  const projectRoot = await realpath(await findNearestPackageRoot(resolve(pageFile)));
  const compilerOptions = await loadCompilerOptions(projectRoot);
  const visited = new Set();

  for (const entryFile of [pageFile, ...layoutFiles, ...snapshotFiles]) {
    let resolvedEntry;
    try {
      resolvedEntry = await realpath(resolve(entryFile));
    } catch {
      continue;
    }
    if (isProjectSourceModule(resolvedEntry, projectRoot)) {
      await scanSourceFile(resolvedEntry, projectRoot, compilerOptions, visited);
    }
  }
}

async function scanSourceFile(file, projectRoot, compilerOptions, visited) {
  if (visited.has(file)) {
    return;
  }
  visited.add(file);

  const source = await readFile(file, "utf8");
  for (const importRecord of parseRuntimeImportRecords(source, file, compilerOptions)) {
    if (!isRelativeSpecifier(importRecord.specifier) && !isAbsolute(importRecord.specifier)) {
      const aliasedFile = await resolveProjectLocalNonRelativeImport(
        importRecord.specifier,
        file,
        projectRoot,
        compilerOptions,
      );
      if (aliasedFile) {
        const owner = portableProjectPath(projectRoot, file);
        const target = portableProjectPath(projectRoot, aliasedFile);
        throw new Error(
          `Ferrite module graph does not support project-local non-relative import ${JSON.stringify(importRecord.specifier)} from ${owner}; it resolves to ${target}. Use a relative import so the compiler-owned graph and server artifact share one resolution contract.`,
        );
      }
      continue;
    }

    const requested = isAbsolute(importRecord.specifier)
      ? importRecord.specifier
      : resolve(dirname(file), importRecord.specifier);
    const importedFile = await resolveSourceFile(requested);
    if (importedFile && isProjectSourceModule(importedFile, projectRoot)) {
      await scanSourceFile(importedFile, projectRoot, compilerOptions, visited);
    }
  }
}

async function loadCompilerOptions(projectRoot) {
  const configPath = join(projectRoot, "tsconfig.json");
  try {
    await access(configPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { ...defaultCompilerOptions };
    }
    throw error;
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      `Ferrite module graph could not read tsconfig.json: ${formatTypeScriptDiagnostics([config.error])}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `Ferrite module graph could not load tsconfig.json: ${formatTypeScriptDiagnostics(parsed.errors)}`,
    );
  }
  return {
    ...defaultCompilerOptions,
    ...parsed.options,
    resolveJsonModule: parsed.options.resolveJsonModule ?? true,
    resolvePackageJsonExports: parsed.options.resolvePackageJsonExports ?? true,
    resolvePackageJsonImports: parsed.options.resolvePackageJsonImports ?? true,
  };
}

function formatTypeScriptDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
    .join("; ");
}

function parseRuntimeImportRecords(source, fileName, compilerOptions) {
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
  const addRecord = (specifier) => records.push({ specifier });
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && importDeclarationHasRuntimeEffect(node.importClause)
    ) {
      addRecord(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addRecord(node.moduleReference.expression.text);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && !node.isTypeOnly
      && exportDeclarationHasRuntimeEffect(node.exportClause)
    ) {
      addRecord(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      addRecord(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "require"
      && requireIsUnbound(node.expression)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      addRecord(node.arguments[0].text);
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

function exportDeclarationHasRuntimeEffect(exportClause) {
  if (!exportClause || ts.isNamespaceExport(exportClause) || exportClause.elements.length === 0) {
    return true;
  }
  return exportClause.elements.some((element) => !element.isTypeOnly);
}

async function resolveProjectLocalNonRelativeImport(specifier, containingFile, projectRoot, compilerOptions) {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (!resolvedModule || resolvedModule.isExternalLibraryImport) {
    return null;
  }

  try {
    const resolved = await realpath(resolvedModule.resolvedFileName);
    return isProjectSourceModule(resolved, projectRoot) ? resolved : null;
  } catch {
    return null;
  }
}

async function resolveSourceFile(path) {
  const extension = extname(path);
  const candidates = extension
    ? [
        path,
        ...(emittedSourceSubstitutions.get(extension) ?? []).map(
          (candidateExtension) => `${path.slice(0, -extension.length)}${candidateExtension}`,
        ),
      ]
    : [
        ...extensionlessSourceExtensions.map((candidateExtension) => `${path}${candidateExtension}`),
        ...extensionlessSourceExtensions.map((candidateExtension) => join(path, `index${candidateExtension}`)),
      ];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      // Try the next source candidate.
    }
  }
  return null;
}

function isProjectSourceModule(file, projectRoot) {
  return isPathInside(projectRoot, file)
    && !relative(projectRoot, file).split(sep).includes("node_modules")
    && sourceExtensions.includes(extname(file).toLowerCase());
}

function isPathInside(root, file) {
  const suffix = relative(root, file);
  return suffix.length > 0
    && suffix !== ".."
    && !suffix.startsWith(`..${sep}`)
    && !isAbsolute(suffix);
}

function portableProjectPath(projectRoot, file) {
  return relative(projectRoot, file).split(sep).join("/");
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function parseOptionalJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function parseOptionalJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function findNearestPackageRoot(filePath) {
  let current = dirname(filePath);
  while (true) {
    try {
      await access(join(current, "package.json"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return process.cwd();
      }
      current = parent;
    }
  }
}
