#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const readModuleFromStdin = args[0] === "--prebuilt-stdin";
if (readModuleFromStdin || args[0] === "--prebuilt") {
  args.shift();
}
const knownModes = new Set([
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
const [serverModule, propsJson = "{}", layoutsJson = "[]", fourthArg, fifthArg = "{}", sixthArg = "{}"] = args;
const documentMode = mode === "--document" || mode === "--document-stream" || mode === "--document-server-payload";
const serverActionMode = mode === "--server-action";
const documentOptionsJson = documentMode ? fifthArg : "{}";
const actionRequestJson = serverActionMode ? fifthArg : "{}";
const routeRenderOptionsJson = documentMode || serverActionMode ? "{}" : fifthArg;

if (!serverModule) {
  console.error(
    "usage: render-artifact [mode] <server-module> [props-json] [layouts-json] [document-marker|conventions-json] [document-options-json|action-request-json]",
  );
  process.exit(2);
}

try {
  const props = parseObject(propsJson, "props");
  parseArray(layoutsJson, "layouts");
  const documentOptions = documentMode ? parseObject(documentOptionsJson, "document options") : {};
  const actionRequest = serverActionMode ? parseObject(actionRequestJson, "server action request") : {};
  const routeRenderOptions = !documentMode && !serverActionMode ? parseObject(routeRenderOptionsJson, "render options") : {};
  const conventionsJson = documentMode ? sixthArg : (fourthArg ?? "{}");
  parseObject(conventionsJson, "route conventions");

  const moduleUrl = readModuleFromStdin
    ? `data:text/javascript;base64,${readFileSync(0).toString("base64")}`
    : `${pathToFileURL(resolve(serverModule)).href}?t=${Date.now()}`;
  const entryModule = await import(moduleUrl);
  const server = entryModule.serverRuntime;
  if (!server || typeof server.renderPageModuleToPacket !== "function") {
    throw new TypeError("Ferrite server artifact is missing its bundled server runtime.");
  }
  const routePattern = entryModule.routePattern;
  if (typeof routePattern !== "string" || !routePattern.startsWith("/")) {
    throw new TypeError("Ferrite server artifact is missing a valid routePattern export.");
  }
  const routePath = concreteRoutePathFromPattern(routePattern, props.params ?? {});
  const renderOptions = { ...routeRenderOptions, routePath, routePattern };

  if (mode === "--metadata") {
    write(await server.collectPageMetadata(entryModule.pageModule, props, entryModule.layoutModules));
  } else if (mode === "--stream") {
    write(
      await server.renderPageModuleToStreamPacket(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.conventionModules,
        renderOptions,
      ),
    );
  } else if (mode === "--server-payload") {
    write(
      await server.renderPageModuleToServerPayload(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.conventionModules,
        renderOptions,
      ),
    );
  } else if (mode === "--server-action") {
    write(
      await server.invokeServerActionFromPageModule(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.conventionModules,
        actionRequest,
        { routePattern },
      ),
    );
  } else if (mode === "--server-action-manifest") {
    write(
      await server.collectServerActionsFromPageModule(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.conventionModules,
        { routePath, routePattern },
      ),
    );
  } else if (mode === "--document") {
    requireDocument(entryModule);
    write(
      await server.renderDocumentModuleToPacket(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.documentModule,
        documentOptions,
        entryModule.conventionModules,
      ),
    );
  } else if (mode === "--document-stream") {
    requireDocument(entryModule);
    write(
      await server.renderDocumentModuleToStreamPacket(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.documentModule,
        documentOptions,
        entryModule.conventionModules,
      ),
    );
  } else if (mode === "--document-server-payload") {
    requireDocument(entryModule);
    write(
      await server.renderDocumentModuleToServerPayload(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.documentModule,
        documentOptions,
        entryModule.conventionModules,
      ),
    );
  } else {
    write(
      await server.renderPageModuleToPacket(
        entryModule.pageModule,
        props,
        entryModule.layoutModules,
        entryModule.conventionModules,
        renderOptions,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}

function parseObject(json, label) {
  const value = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} JSON must be an object`);
  }
  return value;
}

function parseArray(json, label) {
  const value = JSON.parse(json);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} JSON must be an array`);
  }
  return value;
}

function requireDocument(entryModule) {
  if (!entryModule.documentModule) {
    throw new TypeError("Ferrite server artifact does not include a document module.");
  }
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function concreteRoutePathFromPattern(routePattern, params) {
  if (routePattern === "/") {
    return "/";
  }
  const segments = routePattern.slice(1).split("/").flatMap((segment) => {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      const value = params[name];
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`Ferrite route param "${name}" must be a non-empty string.`);
      }
      return encodeURIComponent(value);
    }
    if (segment.startsWith("*")) {
      const optional = segment.endsWith("?");
      const name = segment.slice(1, optional ? -1 : undefined);
      const value = params[name];
      if (optional && value === undefined) {
        return [];
      }
      if (!Array.isArray(value) || (!optional && value.length === 0)) {
        throw new TypeError(`Ferrite route param "${name}" must be ${optional ? "an array" : "a non-empty array"}.`);
      }
      return value.map((part) => {
        if (typeof part !== "string" || part.length === 0) {
          throw new TypeError(`Ferrite route param "${name}" must contain non-empty strings.`);
        }
        return encodeURIComponent(part);
      });
    }
    return segment;
  });
  return `/${segments.join("/")}`;
}
