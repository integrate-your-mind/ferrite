#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { build } from "esbuild";

const request = JSON.parse(await readStandardInput());
validateRequest(request);
const projectRoot = await realpath(resolve(request.project));
const inputs = new Map();

for (const [index, route] of request.routes.entries()) {
  const sourcefile = `.ferrite/generated/server-input-${index}.mjs`;
  const result = await build({
    stdin: {
      contents: serverInputEntrySource(route, request.documentFile),
      resolveDir: projectRoot,
      sourcefile,
      loader: "js",
    },
    absWorkingDir: projectRoot,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    jsxImportSource: "@ferrite/runtime",
    plugins: [projectAliasGuardPlugin(projectRoot)],
    loader: {
      ".css": "empty",
    },
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });

  for (const inputPath of Object.keys(result.metafile.inputs)) {
    if (inputPath === sourcefile || inputPath.startsWith("<")) {
      continue;
    }
    const filesystemInput = inputPath.replace(/[?#].*$/, "");
    const absoluteInput = resolve(projectRoot, filesystemInput);
    const canonicalInput = await realpath(absoluteInput);
    const contents = await readFile(canonicalInput);
    const value = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    const previous = inputs.get(canonicalInput);
    if (previous !== undefined && previous !== value) {
      throw new Error(`Ferrite server build input changed while it was being inspected: ${canonicalInput}`);
    }
    inputs.set(canonicalInput, value);
  }
}

const response = {
  inputs: [...inputs]
    .map(([path, value]) => ({ path, value }))
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
};
process.stdout.write(`${JSON.stringify(response)}\n`);

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ferrite build input request must be an object.");
  }
  if (typeof value.project !== "string" || value.project.length === 0) {
    throw new TypeError("Ferrite build input request requires a project path.");
  }
  if (!Array.isArray(value.routes)) {
    throw new TypeError("Ferrite build input request requires a route array.");
  }
  if (value.documentFile !== null && value.documentFile !== undefined && typeof value.documentFile !== "string") {
    throw new TypeError("Ferrite build input documentFile must be a path or null.");
  }
  for (const route of value.routes) {
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw new TypeError("Ferrite build input route must be an object.");
    }
    if (typeof route.pageFile !== "string" || route.pageFile.length === 0) {
      throw new TypeError("Ferrite build input route requires pageFile.");
    }
    if (!Array.isArray(route.layouts) || route.layouts.some((path) => typeof path !== "string")) {
      throw new TypeError("Ferrite build input route layouts must be file paths.");
    }
    for (const key of ["loadingFile", "errorFile"]) {
      if (route[key] !== null && route[key] !== undefined && typeof route[key] !== "string") {
        throw new TypeError(`Ferrite build input route ${key} must be a path or null.`);
      }
    }
  }
}

function serverInputEntrySource(route, documentFile) {
  const imports = [
    `import * as serverRuntime from "@ferrite/runtime/server";`,
    `import * as pageModule from ${JSON.stringify(resolve(route.pageFile))};`,
    ...route.layouts.map(
      (file, index) => `import * as layout${index} from ${JSON.stringify(resolve(file))};`,
    ),
    ...(documentFile
      ? [`import * as documentModule from ${JSON.stringify(resolve(documentFile))};`]
      : []),
    ...(route.loadingFile
      ? [`import * as loadingModule from ${JSON.stringify(resolve(route.loadingFile))};`]
      : []),
    ...(route.errorFile
      ? [`import * as errorModule from ${JSON.stringify(resolve(route.errorFile))};`]
      : []),
    "void serverRuntime;",
    "void pageModule;",
    ...route.layouts.map((_file, index) => `void layout${index};`),
    ...(documentFile ? ["void documentModule;"] : []),
    ...(route.loadingFile ? ["void loadingModule;"] : []),
    ...(route.errorFile ? ["void errorModule;"] : []),
    "",
  ];
  return imports.join("\n");
}

function projectAliasGuardPlugin(projectRoot) {
  return {
    name: "ferrite-project-alias-guard",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.ferriteAliasGuardResolution === true) {
          return undefined;
        }
        if (
          isRelativeSpecifier(args.path)
          || isAbsolute(args.path)
          || isUrlSpecifier(args.path)
          || isBuiltin(args.path)
        ) {
          return undefined;
        }

        const resolved = await buildApi.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { ferriteAliasGuardResolution: true },
        });
        if (resolved.errors.length > 0 || !resolved.path || resolved.external) {
          return undefined;
        }
        if (resolved.path.split(/[\\/]/).includes("node_modules")) {
          return undefined;
        }

        const importer = await canonicalProjectImporter(args.importer, projectRoot);
        if (!importer) {
          return undefined;
        }
        let target;
        try {
          target = await realpath(resolved.path);
        } catch {
          return undefined;
        }
        if (isPathInside(projectRoot, target)) {
          throw new Error(
            `Ferrite compiler-owned graph does not support project-local non-relative import ${JSON.stringify(args.path)} from ${portableRelative(projectRoot, importer)}; resolved to ${portableRelative(projectRoot, target)}. Use a relative import until alias resolution is owned by the client graph.`,
          );
        }
        return undefined;
      });
    },
  };
}

async function canonicalProjectImporter(importer, projectRoot) {
  if (!importer || importer.startsWith("<") || importer.includes(".ferrite/generated/")) {
    return null;
  }
  let canonical;
  try {
    canonical = await realpath(isAbsolute(importer) ? importer : resolve(projectRoot, importer));
  } catch {
    return null;
  }
  return isPathInside(projectRoot, canonical) ? canonical : null;
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isUrlSpecifier(specifier) {
  return /^(?:data|https?|file):/i.test(specifier);
}

function isPathInside(root, path) {
  const suffix = relative(root, path);
  return suffix.length > 0 && !suffix.startsWith("..") && !isAbsolute(suffix);
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
