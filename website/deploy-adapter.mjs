import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_NAME = "ferrite-server.json";
const BUILD_REPORT_NAME = "ferrite-build.json";
const DEFAULT_SITE_ORIGIN = "https://ferrite.dev";
const GENERATED_METADATA_FILES = new Set(["robots.txt", "sitemap.xml"]);

const FS = {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
};

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
};

function invalid(message) {
  throw new Error(`invalid Ferrite production artifact: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isObject(value)) invalid(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function stringField(value, label) {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function arrayField(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function safeArtifactPath(pathname) {
  stringField(pathname, "artifact path");
  if (
    pathname.length === 0 ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.startsWith("/") ||
    pathname.split("/").some((part) => !part || part === "." || part === "..") ||
    pathname.split("/")[0].endsWith(":")
  ) {
    invalid(`artifact path \`${pathname}\` is not a normalized relative path`);
  }
  return pathname;
}

function safeRoutePath(pathname, label = "route path") {
  stringField(pathname, label);
  if (
    !pathname.startsWith("/") ||
    pathname.includes("//") ||
    (pathname !== "/" && pathname.endsWith("/")) ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.split("/").some((part) => part === "." || part === "..")
  ) {
    invalid(`${label} \`${pathname}\` is not a canonical absolute URL path`);
  }
  return pathname;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function siteOrigin(value = process.env.FERRITE_SITE_ORIGIN) {
  if (value !== undefined && typeof value !== "string") invalid("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  const candidate = value?.trim() || DEFAULT_SITE_ORIGIN;
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(candidate)) {
    invalid("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    invalid("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  return parsed.origin;
}

function mimeType(pathname) {
  return MIME_TYPES.get(extname(pathname).toLowerCase()) ?? "application/octet-stream";
}

function cacheControl(pathname) {
  return /\.[a-f0-9]{8,}\.[a-z0-9]+$/i.test(pathname)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function compactClientReference(reference) {
  const result = {
    id: reference.id,
    module: reference.module,
    exportName: reference.exportName,
  };
  if (reference.script !== null && reference.script !== undefined) result.script = reference.script;
  if (reference.styles.length > 0) result.styles = reference.styles;
  if (reference.outputs.length > 0) result.outputs = reference.outputs;
  if (reference.sourcemaps.length > 0) result.sourcemaps = reference.sourcemaps;
  if (reference.assets.length > 0) result.assets = reference.assets;
  return result;
}

function compactClientBundle(bundle) {
  const result = {
    script: bundle.script ?? null,
  };
  if (bundle.actionBootstrap !== null && bundle.actionBootstrap !== undefined) result.actionBootstrap = bundle.actionBootstrap;
  result.styles = bundle.styles;
  result.outputs = bundle.outputs;
  result.sourcemaps = bundle.sourcemaps;
  result.assets = bundle.assets;
  if (bundle.clientReferences.length > 0) result.clientReferences = bundle.clientReferences.map(compactClientReference);
  if (bundle.moduleGraph.length > 0) {
    result.moduleGraph = bundle.moduleGraph.map((node) => {
      const graphNode = { file: node.file, imports: node.imports };
      if (node.watchFiles.length > 0) graphNode.watchFiles = node.watchFiles;
      return graphNode;
    });
  }
  // inputSnapshot is deliberately skip-serialized by Ferrite's manifest schema.
  return result;
}

function manifestIdentity(manifest) {
  const identity = {
    format: {
      name: manifest.format.name,
      major: manifest.format.major,
      minor: manifest.format.minor,
    },
    clientPublicPath: manifest.clientPublicPath,
    hasDocument: manifest.hasDocument,
    routes: manifest.routes.map((route) => {
      const result = {
        path: route.path,
      };
      if (route.params.length > 0) result.params = route.params;
      result.serverModule = route.serverModule;
      result.clientBundle = compactClientBundle(route.clientBundle);
      if (Object.keys(route.prerendered).length > 0) result.prerendered = route.prerendered;
      if (route.observedActions.length > 0) result.observedActions = route.observedActions;
      return result;
    }),
    files: manifest.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  };
  if (manifest.publicFiles?.length > 0) identity.publicFiles = [...manifest.publicFiles];
  return identity;
}

export function computeManifestBuildId(manifest) {
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(manifestIdentity(manifest))))}`;
}

function validateClientReference(reference, label) {
  exactKeys(reference, new Set(["id", "module", "exportName", "script", "styles", "outputs", "sourcemaps", "assets"]), label);
  stringField(reference.id, `${label}.id`);
  stringField(reference.module, `${label}.module`);
  stringField(reference.exportName, `${label}.exportName`);
  if (reference.script !== undefined && reference.script !== null) stringField(reference.script, `${label}.script`);
  for (const field of ["styles", "outputs", "sourcemaps", "assets"]) {
    const values = reference[field] ?? [];
    arrayField(values, `${label}.${field}`);
    values.forEach((value, index) => {
      const text = stringField(value, `${label}.${field}[${index}]`);
      if (field !== "styles") safeArtifactPath(text);
    });
    reference[field] = values;
  }
  return reference;
}

function validateClientBundle(bundle, route, declaredFiles, clientPublicPath) {
  const label = `route \`${route.path}\` clientBundle`;
  exactKeys(bundle, new Set(["script", "actionBootstrap", "styles", "outputs", "sourcemaps", "assets", "clientReferences", "moduleGraph", "inputSnapshot"]), label);
  if (!("script" in bundle)) invalid(`${label}.script is required by the Ferrite artifact schema`);
  if (bundle.script !== null && bundle.script !== undefined) stringField(bundle.script, `${label}.script`);
  if (bundle.actionBootstrap !== null && bundle.actionBootstrap !== undefined) stringField(bundle.actionBootstrap, `${label}.actionBootstrap`);
  for (const field of ["styles", "outputs", "sourcemaps", "assets"]) {
    if (!(field in bundle)) invalid(`${label}.${field} is required by the Ferrite artifact schema`);
    const values = bundle[field] ?? [];
    arrayField(values, `${label}.${field}`);
    values.forEach((value, index) => {
      const text = stringField(value, `${label}.${field}[${index}]`);
      if (field !== "styles") safeArtifactPath(text);
    });
    bundle[field] = values;
  }
  const references = bundle.clientReferences ?? [];
  arrayField(references, `${label}.clientReferences`);
  references.forEach((reference, index) => validateClientReference(reference, `${label}.clientReferences[${index}]`));
  bundle.clientReferences = references;

  const graph = bundle.moduleGraph ?? [];
  arrayField(graph, `${label}.moduleGraph`);
  graph.forEach((node, index) => {
    const nodeLabel = `${label}.moduleGraph[${index}]`;
    exactKeys(node, new Set(["file", "imports", "watchFiles"]), nodeLabel);
    safeArtifactPath(stringField(node.file, `${nodeLabel}.file`));
    const imports = node.imports ?? [];
    arrayField(imports, `${nodeLabel}.imports`);
    imports.forEach((value, importIndex) => safeArtifactPath(stringField(value, `${nodeLabel}.imports[${importIndex}]`)));
    const watchFiles = node.watchFiles ?? [];
    arrayField(watchFiles, `${nodeLabel}.watchFiles`);
    watchFiles.forEach((value, watchIndex) => safeArtifactPath(stringField(value, `${nodeLabel}.watchFiles[${watchIndex}]`)));
    node.imports = imports;
    node.watchFiles = watchFiles;
  });
  bundle.moduleGraph = graph;
  if (bundle.inputSnapshot !== undefined) {
    const snapshots = arrayField(bundle.inputSnapshot, `${label}.inputSnapshot`);
    snapshots.forEach((snapshot, index) => {
      const snapshotLabel = `${label}.inputSnapshot[${index}]`;
      exactKeys(snapshot, new Set(["path", "kind", "value"]), snapshotLabel);
      stringField(snapshot.path, `${snapshotLabel}.path`);
      stringField(snapshot.kind, `${snapshotLabel}.kind`);
      stringField(snapshot.value, `${snapshotLabel}.value`);
    });
  }

  const required = (relative, kind) => {
    safeArtifactPath(relative);
    if (!declaredFiles.has(relative)) invalid(`${kind} \`${relative}\` is not declared in files`);
  };
  for (const output of bundle.outputs.concat(references.flatMap((reference) => reference.outputs))) {
    safeArtifactPath(output);
    required(join("_ferrite", "static", output).replaceAll("\\", "/"), "client output");
  }
  const publicUrls = [bundle.script, bundle.actionBootstrap, ...bundle.styles, ...references.flatMap((reference) => [reference.script, ...reference.styles])].filter((value) => value !== null && value !== undefined);
  for (const publicUrl of publicUrls) {
    stringField(publicUrl, `${label} public URL`);
    if (!publicUrl.startsWith(`${clientPublicPath}/`)) invalid(`route \`${route.path}\` client URL \`${publicUrl}\` is outside clientPublicPath \`${clientPublicPath}\``);
    const relative = publicUrl.slice(clientPublicPath.length + 1);
    safeArtifactPath(relative);
    required(join("_ferrite", "static", relative).replaceAll("\\", "/"), "client URL target");
  }
  return bundle;
}

function validateManifest(manifest) {
  exactKeys(manifest, new Set(["format", "buildId", "clientPublicPath", "hasDocument", "routes", "files", "publicFiles"]), "manifest");
  exactKeys(manifest.format, new Set(["name", "major", "minor"]), "manifest.format");
  if (manifest.format.name !== "ferrite-server") invalid(`unsupported format \`${manifest.format.name}\``);
  if (manifest.format.major !== 1) invalid(`unsupported format major ${manifest.format.major}; expected 1`);
  if (!Number.isInteger(manifest.format.minor) || manifest.format.minor < 0 || manifest.format.minor > 0) invalid("unsupported format minor");
  if (typeof manifest.buildId !== "string" || !manifest.buildId.startsWith("sha256:") || !isSha256(manifest.buildId.slice(7))) invalid("buildId must be sha256: followed by 64 lowercase hex characters");
  stringField(manifest.clientPublicPath, "manifest.clientPublicPath");
  if (!manifest.clientPublicPath.startsWith("/") || manifest.clientPublicPath === "/" || manifest.clientPublicPath.endsWith("/") || manifest.clientPublicPath.includes("?") || manifest.clientPublicPath.includes("#") || manifest.clientPublicPath.includes("\\")) invalid("clientPublicPath must be a non-root absolute URL path without a trailing slash, query, or fragment");
  if (typeof manifest.hasDocument !== "boolean") invalid("manifest.hasDocument must be a boolean");

  const files = arrayField(manifest.files, "manifest.files");
  const declaredFiles = new Map();
  files.forEach((file, index) => {
    const label = `manifest.files[${index}]`;
    exactKeys(file, new Set(["path", "size", "sha256"]), label);
    const relative = safeArtifactPath(file.path);
    if (relative === MANIFEST_NAME || relative === BUILD_REPORT_NAME) invalid(`reserved manifest file \`${relative}\` cannot be declared`);
    if (declaredFiles.has(relative)) invalid(`duplicate file \`${relative}\``);
    if (!Number.isSafeInteger(file.size) || file.size < 0) invalid(`${label}.size must be a non-negative safe integer`);
    if (!isSha256(file.sha256)) invalid(`${label}.sha256 must be 64 lowercase hex characters`);
    declaredFiles.set(relative, file);
  });

  const publicFiles = manifest.publicFiles ?? [];
  arrayField(publicFiles, "manifest.publicFiles");
  const declaredPublicFiles = new Set();
  publicFiles.forEach((path, index) => {
    const relative = safeArtifactPath(stringField(path, `manifest.publicFiles[${index}]`));
    if (!declaredPublicFiles.add(relative)) invalid(`duplicate public file \`${relative}\``);
    if (!declaredFiles.has(relative)) invalid(`public file \`${relative}\` is not declared in files`);
    if (relative === MANIFEST_NAME || relative.startsWith(`${MANIFEST_NAME}/`) || relative === BUILD_REPORT_NAME || relative.startsWith(`${BUILD_REPORT_NAME}/`) || relative === "server" || relative.startsWith("server/") || relative === "_ferrite" || relative.startsWith("_ferrite/")) invalid(`public file \`${relative}\` collides with a reserved artifact path`);
  });
  manifest.publicFiles = publicFiles;

  const routes = arrayField(manifest.routes, "manifest.routes");
  const routePaths = new Set();
  const prerenderedPaths = new Map();
  routes.forEach((route, index) => {
    const label = `manifest.routes[${index}]`;
    exactKeys(route, new Set(["path", "params", "serverModule", "clientBundle", "prerendered", "observedActions"]), label);
    safeRoutePath(route.path, `${label}.path`);
    if (routePaths.has(route.path)) invalid(`duplicate route \`${route.path}\``);
    routePaths.add(route.path);
    const params = route.params ?? [];
    arrayField(params, `${label}.params`);
    route.params = params;
    route.serverModule = safeArtifactPath(stringField(route.serverModule, `${label}.serverModule`));
    if (!declaredFiles.has(route.serverModule)) invalid(`server module \`${route.serverModule}\` is not declared in files`);
    const prerendered = route.prerendered ?? {};
    if (!isObject(prerendered)) invalid(`${label}.prerendered must be an object`);
    for (const [concretePath, file] of Object.entries(prerendered)) {
      safeRoutePath(concretePath, `${label}.prerendered path`);
      const relative = safeArtifactPath(stringField(file, `${label}.prerendered[${concretePath}]`));
      if (!declaredFiles.has(relative)) invalid(`prerendered HTML \`${relative}\` is not declared in files`);
      if (prerenderedPaths.has(concretePath)) invalid(`duplicate prerendered route \`${concretePath}\``);
      prerenderedPaths.set(concretePath, relative);
    }
    route.prerendered = prerendered;
    const observedActions = route.observedActions ?? [];
    arrayField(observedActions, `${label}.observedActions`);
    const actions = new Set();
    observedActions.forEach((action, actionIndex) => {
      stringField(action, `${label}.observedActions[${actionIndex}]`);
      if (!action.trim() || actions.has(action)) invalid(`${label}.observedActions contains an empty or duplicate id`);
      actions.add(action);
    });
    route.observedActions = observedActions;
    validateClientBundle(route.clientBundle, route, new Set(declaredFiles.keys()), manifest.clientPublicPath);
  });

  const expectedBuildId = computeManifestBuildId(manifest);
  if (manifest.buildId !== expectedBuildId) invalid(`buildId mismatch: expected \`${expectedBuildId}\`, found \`${manifest.buildId}\``);
  return { declaredFiles, prerenderedPaths };
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isMissing(error) {
  return errorCode(error) === "ENOENT";
}

async function canonicalRoot(rootPath, fsApi) {
  const rootInfo = await fsApi.lstat(rootPath).catch((error) => invalid(`artifact directory \`${rootPath}\` is unavailable: ${error.message}`));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) invalid(`artifact root \`${rootPath}\` must be a non-symlink directory`);
  const canonical = await fsApi.realpath(rootPath).catch((error) => invalid(`artifact directory \`${rootPath}\` cannot be resolved: ${error.message}`));
  return { rootPath, canonical };
}

async function regularFile(rootPath, canonical, relative, fsApi) {
  safeArtifactPath(relative);
  let cursor = rootPath;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const info = await fsApi.lstat(cursor).catch((error) => invalid(`artifact file \`${relative}\` is unavailable: ${error.message}`));
    if (info.isSymbolicLink()) invalid(`artifact file \`${relative}\` is a symlink/reparse point`);
    if (index < parts.length - 1 && !info.isDirectory()) invalid(`artifact path component for \`${relative}\` is not a directory`);
    if (index === parts.length - 1 && !info.isFile()) invalid(`artifact file \`${relative}\` is not a regular file`);
  }
  const resolved = await fsApi.realpath(cursor).catch((error) => invalid(`artifact file \`${relative}\` cannot be resolved: ${error.message}`));
  const expected = join(canonical, ...parts);
  if (resolved !== expected) invalid(`artifact file \`${relative}\` resolves through a symlink/reparse point`);
  return { path: cursor, info: await fsApi.lstat(cursor) };
}

async function collectArtifactPaths(rootPath, canonical, fsApi, prefix = "") {
  const directory = prefix ? join(rootPath, prefix) : rootPath;
  const entries = await fsApi.readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeArtifactPath(relative);
    const absolute = join(rootPath, relative);
    const info = await fsApi.lstat(absolute);
    if (info.isSymbolicLink()) invalid(`artifact path \`${relative}\` is a symlink/reparse point`);
    const resolved = await fsApi.realpath(absolute);
    if (resolved !== join(canonical, ...relative.split("/"))) invalid(`artifact path \`${relative}\` resolves through a symlink/reparse point`);
    if (info.isDirectory()) {
      paths.push(...(await collectArtifactPaths(rootPath, canonical, fsApi, relative)));
    } else if (info.isFile()) {
      paths.push(relative);
    } else {
      invalid(`artifact path \`${relative}\` is not a regular file or directory`);
    }
  }
  return paths;
}

async function loadAndVerifyArtifact(artifactDirectory, fsApi) {
  const artifact = resolve(artifactDirectory);
  const { rootPath, canonical } = await canonicalRoot(artifact, fsApi);
  const manifestRecord = await regularFile(rootPath, canonical, MANIFEST_NAME, fsApi);
  let manifest;
  try {
    manifest = JSON.parse((await fsApi.readFile(manifestRecord.path)).toString("utf8"));
  } catch (error) {
    invalid(`manifest \`${join(rootPath, MANIFEST_NAME)}\` is malformed: ${error.message}`);
  }
  const { declaredFiles, prerenderedPaths } = validateManifest(manifest);
  const actualPaths = await collectArtifactPaths(rootPath, canonical, fsApi);
  for (const actual of actualPaths) {
    if (actual === MANIFEST_NAME || actual === BUILD_REPORT_NAME) continue;
    if (!declaredFiles.has(actual)) invalid(`undeclared artifact file \`${actual}\``);
  }
  const bytesByPath = new Map();
  for (const [relative, record] of declaredFiles) {
    const file = await regularFile(rootPath, canonical, relative, fsApi);
    const bytes = Buffer.from(await fsApi.readFile(file.path));
    if (bytes.byteLength !== record.size) invalid(`size mismatch for \`${relative}\`: expected ${record.size}, found ${bytes.byteLength}`);
    const digest = sha256Hex(bytes);
    if (digest !== record.sha256) invalid(`SHA-256 mismatch for \`${relative}\`: expected ${record.sha256}, found ${digest}`);
    bytesByPath.set(relative, bytes);
  }
  return { artifact, canonical, manifest, declaredFiles, prerenderedPaths, bytesByPath };
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderSitemap(manifest, origin) {
  const paths = [...new Set(manifest.routes.flatMap((route) => Object.keys(route.prerendered ?? {})))].sort();
  const entries = paths.map((pathname) => {
    const url = new URL(pathname, `${origin}/`).toString();
    return `  <url><loc>${xmlEscape(url)}</loc></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

export function renderRobots(origin) {
  return `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
}

function generatedMetadata(manifest, origin) {
  return new Map([
    ["robots.txt", Buffer.from(renderRobots(origin))],
    ["sitemap.xml", Buffer.from(renderSitemap(manifest, origin))],
  ]);
}

function outputManifestWithPublicFiles(manifest, publicBytes) {
  const files = new Map(manifest.files.map((file) => [file.path, { ...file }]));
  for (const [path, bytes] of publicBytes) {
    files.set(path, { path, size: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  const output = {
    ...manifest,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    publicFiles: [...new Set([...(manifest.publicFiles ?? []), ...publicBytes.keys()])].sort(),
  };
  output.buildId = computeManifestBuildId(output);
  validateManifest(output);
  return output;
}

async function loadPublicFiles(publicDirectory, fsApi) {
  try {
    const info = await fsApi.lstat(publicDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) invalid(`public directory \`${publicDirectory}\` must be a non-symlink directory`);
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
  const publicRoot = await canonicalRoot(publicDirectory, fsApi);
  const files = new Map();
  for (const relative of await collectArtifactPaths(publicDirectory, publicRoot.canonical, fsApi)) {
    if (GENERATED_METADATA_FILES.has(relative)) continue;
    const file = await regularFile(publicDirectory, publicRoot.canonical, relative, fsApi);
    files.set(relative, Buffer.from(await fsApi.readFile(file.path)));
  }
  return files;
}

async function writeBytes(destination, bytes, fsApi) {
  await fsApi.mkdir(dirname(destination), { recursive: true });
  await fsApi.writeFile(destination, bytes);
}

async function verifyStagedOutput(staging, manifest, fsApi, serverFiles, expectedClientBytes) {
  const client = join(staging, "client");
  const server = join(staging, "server");
  const openai = join(staging, ".openai");
  const { declaredFiles } = validateManifest(manifest);
  const clientRoot = await canonicalRoot(client, fsApi);
  const serverRoot = await canonicalRoot(server, fsApi);
  const openaiRoot = await canonicalRoot(openai, fsApi);
  const stagingRoot = await canonicalRoot(staging, fsApi);
  const expectedClientPaths = new Set([MANIFEST_NAME]);
  for (const file of manifest.files) if (!serverFiles.has(file.path)) expectedClientPaths.add(file.path);
  const actualClientPaths = await collectArtifactPaths(client, clientRoot.canonical, fsApi);
  if (actualClientPaths.some((path) => !expectedClientPaths.has(path)) || [...expectedClientPaths].some((path) => !actualClientPaths.includes(path))) invalid("staged client output is incomplete or contains undeclared files");
  const actualServerPaths = await collectArtifactPaths(server, serverRoot.canonical, fsApi);
  if (actualServerPaths.sort().join("\n") !== ["adapter.mjs", "index.js", "source-build.json"].join("\n")) invalid("staged server output is incomplete or contains undeclared files");
  const actualOpenaiPaths = await collectArtifactPaths(openai, openaiRoot.canonical, fsApi);
  if (actualOpenaiPaths.length !== 1 || actualOpenaiPaths[0] !== "hosting.json") invalid("staged hosting output is incomplete or contains undeclared files");
  const manifestBytes = Buffer.from(await fsApi.readFile(join(client, MANIFEST_NAME)));
  const copiedManifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(copiedManifest);
  if (JSON.stringify(copiedManifest) !== JSON.stringify(manifest)) invalid("staged manifest differs from the validated output manifest");
  for (const [relative, record] of declaredFiles) {
    if (serverFiles.has(relative)) continue;
    const file = await regularFile(client, clientRoot.canonical, relative, fsApi);
    const bytes = Buffer.from(await fsApi.readFile(file.path));
    if (bytes.byteLength !== record.size || sha256Hex(bytes) !== record.sha256) invalid(`staged output integrity mismatch for \`${relative}\``);
    const expected = expectedClientBytes.get(relative);
    if (expected && !expected.equals(bytes)) invalid(`staged output bytes differ from the verified source for \`${relative}\``);
  }
  for (const required of ["adapter.mjs", "index.js", "source-build.json"]) await regularFile(server, serverRoot.canonical, required, fsApi);
  await regularFile(staging, stagingRoot.canonical, ".openai/hosting.json", fsApi);
  return true;
}

export async function atomicReplaceDirectory(staging, dist, fsApi = FS) {
  const destination = resolve(dist);
  const parent = dirname(destination);
  let existing = false;
  try {
    const info = await fsApi.lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`destination \`${destination}\` must be a non-symlink directory`);
    existing = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const backup = existing ? join(parent, `.${basename(destination)}.backup-${randomUUID()}`) : null;
  if (existing) await fsApi.rename(destination, backup);
  try {
    await fsApi.rename(staging, destination);
  } catch (error) {
    if (existing) {
      try {
        await fsApi.rename(backup, destination);
      } catch (rollbackError) {
        const failure = new Error(`activation failed and rollback failed; backup preserved at ${backup}: ${rollbackError.message}`);
        failure.backupPath = backup;
        throw failure;
      }
    }
    throw error;
  }
  if (existing) {
    try {
      await fsApi.rm(backup, { recursive: true, force: true });
    } catch (error) {
      const failure = new Error(`activation succeeded but prior dist backup was preserved at ${backup}: ${error.message}`);
      failure.activePath = destination;
      failure.backupPath = backup;
      throw failure;
    }
  }
  return { destination, backupPath: null };
}

const GENERATED_SERVER_ENTRY = `import { createSiteServer } from "./adapter.mjs";
const server = createSiteServer(new URL("../", import.meta.url));
export { server };
export default server;
`;

export async function packageArtifact(
  artifactDirectory = join(root, ".ferrite", "build"),
  distDirectory = join(root, "dist"),
  options = {},
) {
  const fsApi = options.fs ?? FS;
  const artifactResult = await loadAndVerifyArtifact(artifactDirectory, fsApi);
  const origin = siteOrigin(options.siteOrigin);
  const generated = generatedMetadata(artifactResult.manifest, origin);
  const publicBytes = await loadPublicFiles(options.publicDirectory ?? join(root, "public"), fsApi);
  for (const relative of publicBytes.keys()) {
    if (artifactResult.declaredFiles.has(relative)) invalid(`public file \`${relative}\` collides with a declared artifact file`);
  }
  for (const [relative, bytes] of generated) publicBytes.set(relative, bytes);
  const manifest = outputManifestWithPublicFiles(artifactResult.manifest, publicBytes);
  const dist = resolve(distDirectory);
  const parent = dirname(dist);
  await fsApi.mkdir(parent, { recursive: true });
  const staging = await fsApi.mkdtemp(join(parent, `.${basename(dist)}.staging-`));
  let activated = false;
  const serverFiles = new Set(artifactResult.manifest.routes.map((route) => route.serverModule));
  const clientBytes = new Map(artifactResult.bytesByPath);
  for (const [relative, bytes] of publicBytes) clientBytes.set(relative, bytes);
  try {
    const client = join(staging, "client");
    const server = join(staging, "server");
    for (const [relative, bytes] of clientBytes) {
      if (serverFiles.has(relative)) continue;
      await writeBytes(join(client, relative), bytes, fsApi);
    }
    await writeBytes(join(client, MANIFEST_NAME), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), fsApi);
    await writeBytes(join(server, "adapter.mjs"), Buffer.from(await readFile(new URL("./deploy-adapter.mjs", import.meta.url))), fsApi);
    await writeBytes(join(server, "index.js"), Buffer.from(GENERATED_SERVER_ENTRY), fsApi);
    await writeBytes(join(server, "source-build.json"), Buffer.from(`${JSON.stringify({ sourceBuildId: artifactResult.manifest.buildId, outputBuildId: manifest.buildId, siteOrigin: origin }, null, 2)}\n`), fsApi);
    const projectRoot = await canonicalRoot(root, fsApi);
    const hostingSource = await regularFile(root, projectRoot.canonical, ".openai/hosting.json", fsApi);
    const hostingBytes = Buffer.from(await fsApi.readFile(hostingSource.path));
    await writeBytes(join(staging, ".openai", "hosting.json"), hostingBytes, fsApi);
    await verifyStagedOutput(staging, manifest, fsApi, serverFiles, clientBytes);
    await atomicReplaceDirectory(staging, dist, fsApi);
    activated = true;
    return {
      artifact: artifactResult.artifact,
      dist,
      server: join(dist, "server", "index.js"),
      client: join(dist, "client"),
      hosting: join(dist, ".openai", "hosting.json"),
      manifest,
      sourceBuildId: artifactResult.manifest.buildId,
      siteOrigin: origin,
    };
  } catch (error) {
    if (!activated && !error?.activePath) {
      try {
        await fsApi.rm(staging, { recursive: true, force: true });
      } catch (cleanupError) {
        const failure = new Error(`${error.message}; staging preserved at ${staging}: ${cleanupError.message}`);
        failure.stagingPath = staging;
        if (error?.backupPath) failure.backupPath = error.backupPath;
        throw failure;
      }
    }
    throw error;
  }
}

async function readManifest(clientDirectory) {
  const bytes = await readFile(join(clientDirectory, MANIFEST_NAME));
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    invalid(`served manifest is malformed: ${error.message}`);
  }
  validateManifest(manifest);
  return manifest;
}

function routeFiles(manifest) {
  const routes = new Map();
  for (const route of manifest.routes) {
    for (const [pathname, file] of Object.entries(route.prerendered ?? {})) routes.set(pathname, file);
  }
  return routes;
}

async function resolveRequestFile(clientDirectory, pathname, manifest) {
  const declared = new Set(manifest.files.map((file) => file.path));
  const routeMap = routeFiles(manifest);
  const clientCanonical = await realpath(clientDirectory);
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : "/";
  const prerendered = routeMap.get(normalized);
  const candidates = [];
  if (prerendered && declared.has(prerendered)) candidates.push(prerendered);
  const relative = normalized === "/" ? "index.html" : normalized.slice(1);
  if (declared.has(relative)) candidates.push(relative);
  if (!extname(relative) && declared.has(`${relative}/index.html`)) candidates.push(`${relative}/index.html`);
  for (const candidate of candidates) {
    const target = join(clientDirectory, candidate);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const resolved = await realpath(target);
      if (resolved !== join(clientCanonical, ...candidate.split("/"))) continue;
      return target;
    } catch {}
  }
  return null;
}

async function handleNodeRequest(request, response, clientDirectory) {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    request.resume();
    response.writeHead(405, {
      ...SECURITY_HEADERS,
      Allow: "GET, HEAD",
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    }).end("Method not allowed");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://ferrite.invalid").pathname);
  } catch {
    response.writeHead(400, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    response.writeHead(400, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }
  const manifest = await readManifest(clientDirectory);
  const target = await resolveRequestFile(clientDirectory, pathname, manifest);
  if (!target) {
    response.writeHead(404, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { ...SECURITY_HEADERS, "Cache-Control": cacheControl(target), "Content-Type": mimeType(target) });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Internal server error");
  }
}

export function createSiteServer(distDirectory = join(root, "dist")) {
  const dist = distDirectory instanceof URL ? fileURLToPath(distDirectory) : resolve(distDirectory);
  const client = join(dist, "client");
  return createServer((request, response) => {
    handleNodeRequest(request, response, client).catch(() => {
      if (!response.headersSent) response.writeHead(500, { ...SECURITY_HEADERS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal server error");
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await packageArtifact();
  if (process.env.FERRITE_SITES_SERVE === "1") {
    const port = Number(process.env.PORT ?? 8788);
    createSiteServer(result.dist).listen(port, "127.0.0.1", () => console.log(`Ferrite Sites adapter listening on 127.0.0.1:${port}`));
  } else {
    console.log(`Ferrite Sites artifact packaged at ${result.dist}`);
  }
}
