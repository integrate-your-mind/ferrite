import type {
  DocumentModule,
  DocumentRenderOptions,
  LayoutModule,
  Metadata,
  PageModule,
  RouteConventionModules,
  ServerRenderOptions,
} from "./server.js";
import type { CompactNode, RenderPacket } from "./index.js";

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const DEFAULT_MAX_PACKET_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESPONSE_DEADLINE_MS = 1_000;
const MAX_ASSET_MANIFEST_BYTES = 64 * 1024;
const SERVER_ACTION_URL = "/_ferrite/action";
const SERVER_ACTION_ID_FIELD = "__ferrite_action";

export type CloudflareAssetsBinding = {
  fetch(request: Request): Promise<Response>;
};

export type CloudflareSsrEnv = {
  ASSETS?: CloudflareAssetsBinding;
  [name: string]: unknown;
};

export type CloudflareHtmlRenderer = {
  renderPacketJsonToHtml(json: string, maxOutputBytes?: number): string;
};

export type CloudflareServerRuntime = {
  collectPageMetadata(
    pageModule: PageModule,
    props?: Record<string, unknown>,
    layouts?: LayoutModule[],
  ): Promise<Metadata>;
  renderPageModuleToPacket(
    pageModule: PageModule,
    props?: Record<string, unknown>,
    layouts?: LayoutModule[],
    conventions?: RouteConventionModules,
    renderOptions?: ServerRenderOptions,
  ): Promise<RenderPacket>;
  renderDocumentModuleToPacket(
    pageModule: PageModule,
    props: Record<string, unknown>,
    layouts: LayoutModule[],
    documentModule: DocumentModule,
    options: DocumentRenderOptions,
    conventions?: RouteConventionModules,
  ): Promise<RenderPacket>;
};

export type CloudflareRouteModule = {
  pageModule: PageModule;
  serverRuntime: CloudflareServerRuntime;
  routePattern: string;
  layoutModules?: LayoutModule[];
  documentModule?: DocumentModule | null;
  conventionModules?: RouteConventionModules;
  cloudflare: {
    format: "ferrite-cloudflare-route";
    version: 2;
    sourceBuildId: string;
    metadataBuildId: string;
    moduleBuildId: string;
    assetBuildId: string;
    path: string;
    fallbackPath: string;
    observedActions: string[];
  };
};

export type CloudflareSsrRoute = {
  module: CloudflareRouteModule;
  props?: Record<string, unknown>;
  document?: Omit<DocumentRenderOptions, "metadata" | "routePath" | "routePattern">;
};

export type CloudflareSsrOptions<Env extends CloudflareSsrEnv = CloudflareSsrEnv> = {
  routes: CloudflareSsrRoute[];
  renderer: CloudflareHtmlRenderer;
  maxPacketBytes?: number;
  maxHtmlBytes?: number;
  responseDeadlineMs?: number;
  assetManifestSha256: string;
  shouldRender?: (request: Request, env: Env) => boolean;
};

type PreparedRoute = CloudflareSsrRoute & {
  path: string;
  fallbackPath: string;
  sourceBuildId: string;
  metadataBuildId: string;
  moduleBuildId: string;
  assetBuildId: string;
  layoutModules: LayoutModule[];
  conventionModules: RouteConventionModules;
  props: Record<string, unknown>;
};

class ResponseDeadlineError extends Error {
  constructor() {
    super("Ferrite Cloudflare request-time response exceeded its deadline.");
    this.name = "ResponseDeadlineError";
  }
}

export function createCloudflareSsrHandler<Env extends CloudflareSsrEnv = CloudflareSsrEnv>(
  options: CloudflareSsrOptions<Env>,
): { fetch(request: Request, env: Env): Promise<Response> } {
  const prepared = prepareRoutes(options.routes);
  const routes = prepared.routes;
  const maxPacketBytes = positiveLimit(options.maxPacketBytes, DEFAULT_MAX_PACKET_BYTES, "packet byte");
  const maxHtmlBytes = positiveLimit(options.maxHtmlBytes, DEFAULT_MAX_HTML_BYTES, "HTML byte");
  const responseDeadlineMs = positiveLimit(
    options.responseDeadlineMs,
    DEFAULT_RESPONSE_DEADLINE_MS,
    "response deadline millisecond",
  );
  if (!options.renderer || typeof options.renderer.renderPacketJsonToHtml !== "function") {
    throw new TypeError("Ferrite Cloudflare SSR requires a packet-to-HTML renderer.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.assetManifestSha256)) {
    throw new TypeError(
      "Ferrite Cloudflare SSR requires the exact SHA-256 identity of ferrite-server.json.",
    );
  }
  if (options.shouldRender !== undefined && typeof options.shouldRender !== "function") {
    throw new TypeError("Ferrite Cloudflare shouldRender must be a function when provided.");
  }

  return {
    async fetch(request, env) {
      const method = request.method || "GET";
      if (method !== "GET" && method !== "HEAD") {
        return errorResponse(405, "Method not allowed", { Allow: "GET, HEAD" });
      }

      const parsed = requestPath(request);
      if (parsed.error) {
        return parsed.error;
      }
      const route = routes.get(parsed.pathname);
      if (!route) {
        return fetchAsset(request, env);
      }
      if (!acceptsHtml(request.headers.get("accept"))) {
        return errorResponse(406, "Not acceptable");
      }
      if (parsed.url.searchParams.has("__ferrite_payload")) {
        return errorResponse(501, "Ferrite Worker payload streaming is not supported");
      }
      throwIfAborted(request.signal);
      const deadline = monotonicNow() + responseDeadlineMs;
      try {
        await verifyAssetsBuildIdentity(
          request,
          env,
          prepared.assetBuildId,
          options.assetManifestSha256,
          routes.values(),
          request.signal,
          deadline,
        );
      } catch (error) {
        if (request.signal.aborted) {
          throw abortError();
        }
        return error instanceof ResponseDeadlineError
          ? errorResponse(504, "Gateway timeout")
          : errorResponse(500, "Internal server error");
      }

      let useSsr = true;
      try {
        useSsr = options.shouldRender?.(request, env) ?? true;
      } catch {
        useSsr = false;
      }
      if (!useSsr) {
        return fetchFallback(
          request,
          env,
          route.fallbackPath,
          500,
          responseDeadlineMs,
          maxHtmlBytes,
        );
      }

      try {
        const packet = await withinRequestBudget(
          renderRoutePacket(route, parsed.pathname),
          request.signal,
          deadline,
        );
        const packetJson = JSON.stringify(packet);
        if (byteLength(packetJson) > maxPacketBytes) {
          throw new TypeError(`Ferrite render packet exceeds the ${maxPacketBytes}-byte limit.`);
        }
        ensureBeforeDeadline(deadline);
        if (containsServerAction(packet.root)) {
          throw new TypeError("Ferrite Cloudflare routes cannot render server actions.");
        }
        const documentPrefix = route.module.documentModule ? "<!doctype html>\n" : "";
        const rendererLimit = maxHtmlBytes - byteLength(documentPrefix);
        if (rendererLimit <= 0) {
          throw new TypeError(
            `Ferrite document prefix exceeds the ${maxHtmlBytes}-byte HTML limit.`,
          );
        }
        const html = options.renderer.renderPacketJsonToHtml(packetJson, rendererLimit);
        if (typeof html !== "string") {
          throw new TypeError("Ferrite Cloudflare packet renderer must return HTML text.");
        }
        const body = `${documentPrefix}${html}`;
        if (byteLength(body) > maxHtmlBytes) {
          throw new TypeError(`Ferrite rendered HTML exceeds the ${maxHtmlBytes}-byte limit.`);
        }
        ensureBeforeDeadline(deadline);
        throwIfAborted(request.signal);

        return new Response(method === "HEAD" ? null : body, {
          status: 200,
          headers: responseHeaders("no-store", {
            "Content-Type": "text/html; charset=utf-8",
            "X-Ferrite-Render": "request",
          }),
        });
      } catch (error) {
        if (request.signal.aborted) {
          throw abortError();
        }
        const status = error instanceof ResponseDeadlineError ? 504 : 500;
        return fetchFallback(
          request,
          env,
          route.fallbackPath,
          status,
          responseDeadlineMs,
          maxHtmlBytes,
        );
      }
    },
  };
}

async function renderRoutePacket(route: PreparedRoute, pathname: string): Promise<RenderPacket> {
  const {
    pageModule,
    serverRuntime,
    documentModule,
    routePattern,
  } = route.module;
  if (documentModule) {
    const metadata = await serverRuntime.collectPageMetadata(
      pageModule,
      route.props,
      route.layoutModules,
    );
    return serverRuntime.renderDocumentModuleToPacket(
      pageModule,
      route.props,
      route.layoutModules,
      documentModule,
      {
        rootId: "ferrite-root",
        ...route.document,
        routePath: pathname,
        routePattern,
        metadata,
      },
      route.conventionModules,
    );
  }

  return serverRuntime.renderPageModuleToPacket(
    pageModule,
    route.props,
    route.layoutModules,
    route.conventionModules,
    { routePath: pathname, routePattern },
  );
}

function prepareRoutes(routes: CloudflareSsrRoute[]): {
  routes: Map<string, PreparedRoute>;
  assetBuildId: string;
} {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new TypeError("Ferrite Cloudflare SSR requires at least one route.");
  }
  const prepared = new Map<string, PreparedRoute>();
  let assetBuildId: string | undefined;
  for (const route of routes) {
    if (!route || typeof route !== "object") {
      throw new TypeError("Ferrite Cloudflare SSR routes must be objects.");
    }
    if (!route.module || typeof route.module !== "object") {
      throw new TypeError("Ferrite Cloudflare SSR route is missing its module.");
    }
    const identity = route.module.cloudflare;
    if (
      !identity ||
      identity.format !== "ferrite-cloudflare-route" ||
      identity.version !== 2
    ) {
      throw new TypeError("Ferrite Cloudflare SSR route is missing its generated edge identity.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(identity.sourceBuildId)) {
      throw new TypeError("Ferrite Cloudflare SSR route has an invalid source build identity.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(identity.metadataBuildId)) {
      throw new TypeError("Ferrite Cloudflare SSR route has an invalid metadata build identity.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(identity.moduleBuildId)) {
      throw new TypeError("Ferrite Cloudflare SSR route has an invalid module build identity.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(identity.assetBuildId)) {
      throw new TypeError("Ferrite Cloudflare SSR route has an invalid asset build identity.");
    }
    if (assetBuildId !== undefined && identity.assetBuildId !== assetBuildId) {
      throw new TypeError("Ferrite Cloudflare SSR routes must come from one asset build identity.");
    }
    assetBuildId = identity.assetBuildId;
    const path = configuredPath(identity.path, "route path");
    if (path.split("/").some((segment) => segment.startsWith(":") || segment.startsWith("*"))) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" is dynamic; the initial Worker adapter accepts exact routes only.`,
      );
    }
    const fallbackPath = configuredPath(identity.fallbackPath, `fallback path for "${path}"`);
    if (prepared.has(path)) {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" is duplicated.`);
    }
    if (!route.module.pageModule || typeof route.module.pageModule.default !== "function") {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" is missing its page component.`);
    }
    if (route.module.routePattern !== path) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" does not match module pattern "${String(route.module.routePattern)}".`,
      );
    }
    if (!route.module.serverRuntime || typeof route.module.serverRuntime.renderPageModuleToPacket !== "function") {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" is missing its bundled server runtime.`);
    }
    if (typeof route.module.serverRuntime.collectPageMetadata !== "function") {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" cannot collect metadata.`);
    }
    if (route.module.documentModule && typeof route.module.serverRuntime.renderDocumentModuleToPacket !== "function") {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" cannot render its document module.`);
    }
    if (
      route.module.documentModule &&
      typeof route.module.documentModule.default !== "function"
    ) {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" has an invalid document component.`);
    }
    if (
      route.module.layoutModules !== undefined &&
      !Array.isArray(route.module.layoutModules)
    ) {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" has invalid layout modules.`);
    }
    if (
      route.module.conventionModules !== undefined &&
      (!route.module.conventionModules ||
        typeof route.module.conventionModules !== "object" ||
        Array.isArray(route.module.conventionModules))
    ) {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" has invalid convention modules.`);
    }
    if (!Array.isArray(identity.observedActions)) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" must include its build-observed server action list.`,
      );
    }
    if (identity.observedActions.length > 0) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" contains server actions, which the initial Worker adapter does not support.`,
      );
    }
    if (identity.observedActions.some((action) => typeof action !== "string" || action.length === 0)) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" has an invalid build-observed server action list.`,
      );
    }
    if (route.props !== undefined && (!route.props || typeof route.props !== "object" || Array.isArray(route.props))) {
      throw new TypeError(`Ferrite Cloudflare SSR props for "${path}" must be an object.`);
    }
    prepared.set(path, {
      ...route,
      path,
      fallbackPath,
      sourceBuildId: identity.sourceBuildId,
      metadataBuildId: identity.metadataBuildId,
      moduleBuildId: identity.moduleBuildId,
      assetBuildId: identity.assetBuildId,
      props: route.props ?? {},
      layoutModules: route.module.layoutModules ?? [],
      conventionModules: route.module.conventionModules ?? {},
    });
  }
  return {
    routes: prepared,
    assetBuildId: assetBuildId as string,
  };
}

async function verifyAssetsBuildIdentity<Env extends CloudflareSsrEnv>(
  request: Request,
  env: Env,
  expectedAssetBuildId: string,
  expectedManifestSha256: string,
  expectedRoutes: Iterable<PreparedRoute>,
  signal: AbortSignal,
  deadline: number,
): Promise<void> {
  const binding = env?.ASSETS;
  if (!binding || typeof binding.fetch !== "function") {
    throw new TypeError("Ferrite Cloudflare SSR requires an ASSETS binding.");
  }
  const manifestUrl = new URL(request.url);
  manifestUrl.pathname = "/ferrite-server.json";
  manifestUrl.search = "";
  manifestUrl.hash = "";
  const response = await withinRequestBudget(
    binding.fetch(new Request(manifestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    })),
    signal,
    deadline,
  );
  if (response.status !== 200) {
    throw new TypeError("Ferrite Cloudflare asset manifest is unavailable.");
  }
  const bytes = await readBoundedResponseBody(
    response,
    MAX_ASSET_MANIFEST_BYTES,
    "asset manifest",
    signal,
    deadline,
  );
  if (await sha256BuildId(bytes) !== expectedManifestSha256) {
    throw new TypeError("Ferrite Cloudflare asset manifest bytes do not match the Worker build.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Ferrite Cloudflare asset manifest is invalid.");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !("format" in manifest) ||
    !manifest.format ||
    typeof manifest.format !== "object" ||
    Array.isArray(manifest.format) ||
    !("name" in manifest.format) ||
    manifest.format.name !== "ferrite-server" ||
    !("major" in manifest.format) ||
    manifest.format.major !== 1 ||
    !("buildId" in manifest) ||
    manifest.buildId !== expectedAssetBuildId ||
    !("routes" in manifest) ||
    !Array.isArray(manifest.routes)
  ) {
    throw new TypeError("Ferrite Cloudflare asset manifest does not match the route build identity.");
  }
  const manifestPaths = new Set<string>();
  for (const candidate of manifest.routes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.path !== "string" ||
      manifestPaths.has(candidate.path)
    ) {
      throw new TypeError("Ferrite Cloudflare asset manifest contains invalid or duplicate routes.");
    }
    manifestPaths.add(candidate.path);
  }
  for (const expected of expectedRoutes) {
    const matches = manifest.routes.filter((candidate) =>
      isRecord(candidate) &&
      candidate.path === expected.path
    );
    if (matches.length !== 1) {
      throw new TypeError(
        `Ferrite Cloudflare asset manifest must contain exactly one route "${expected.path}".`,
      );
    }
    const route = matches[0];
    const prerendered = isRecord(route?.prerendered)
      ? route.prerendered
      : undefined;
    const observedActions = route?.observedActions;
    const cloudflare = isRecord(route?.cloudflare)
      ? route.cloudflare
      : undefined;
    if (
      !route ||
      !prerendered ||
      prerendered[expected.path] !== expected.fallbackPath.slice(1) ||
      !Array.isArray(observedActions) ||
      observedActions.length !== 0 ||
      !cloudflare ||
      cloudflare.path !== expected.path ||
      cloudflare.sourceBuildId !== expected.sourceBuildId ||
      cloudflare.metadataBuildId !== expected.metadataBuildId ||
      cloudflare.moduleBuildId !== expected.moduleBuildId ||
      !Number.isSafeInteger(cloudflare.moduleBytes) ||
      (cloudflare.moduleBytes as number) <= 0 ||
      !/^[a-f0-9]{64}$/.test(String(cloudflare.moduleSha256 ?? "")) ||
      !Number.isSafeInteger(cloudflare.receiptBytes) ||
      (cloudflare.receiptBytes as number) <= 0 ||
      !/^[a-f0-9]{64}$/.test(String(cloudflare.receiptSha256 ?? ""))
    ) {
      throw new TypeError(
        `Ferrite Cloudflare asset manifest does not bind route "${expected.path}" to its action-free fallback.`,
      );
    }
  }
}

async function sha256BuildId(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
  deadline: number,
): Promise<Uint8Array> {
  const declaredSize = response.headers.get("content-length");
  if (
    declaredSize !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declaredSize) ||
      Number(declaredSize) > maxBytes)
  ) {
    throw new TypeError(`Ferrite Cloudflare ${label} exceeds its byte limit.`);
  }
  if (!response.body) {
    if (declaredSize !== null && Number(declaredSize) !== 0) {
      throw new TypeError(`Ferrite Cloudflare ${label} ended before its declared length.`);
    }
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withinRequestBudget(
        reader.read(),
        signal,
        deadline,
      );
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new TypeError(`Ferrite Cloudflare ${label} exceeds its byte limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelResponseReader(
      reader,
      `Ferrite Cloudflare ${label} could not be read completely.`,
    );
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative source may retain the pending read after cancellation.
    }
  }
  if (declaredSize !== null && total !== Number(declaredSize)) {
    throw new TypeError(`Ferrite Cloudflare ${label} ended before its declared length.`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): void {
  try {
    void reader.cancel(reason).catch(() => {
      // The original stream, abort, or deadline failure remains authoritative.
    });
  } catch {
    // The original stream, abort, or deadline failure remains authoritative.
  }
}

function containsServerAction(node: CompactNode): boolean {
  if (!Array.isArray(node) || node.length < 2) {
    return false;
  }
  if (node[0] === 0) {
    return false;
  }
  if (node[0] === 1) {
    return Array.isArray(node[1]) && node[1].some(containsServerAction);
  }
  if (node[0] !== 2 || node.length !== 4) {
    return false;
  }
  const tag = typeof node[1] === "string" ? node[1].toLowerCase() : "";
  const props = node[2];
  if (
    props &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    ((tag === "form" && props.action === SERVER_ACTION_URL) ||
      (tag === "input" && props.name === SERVER_ACTION_ID_FIELD))
  ) {
    return true;
  }
  return Array.isArray(node[3]) && node[3].some(containsServerAction);
}

function requestPath(request: Request): { url: URL; pathname: string; error?: never } | { error: Response } {
  try {
    const url = new URL(request.url);
    const encoded = url.pathname;
    if (
      /%(?:25)*(?:00|2f|5c)/i.test(encoded) ||
      /(?:^|\/)(?:%(?:25)*2e){1,2}(?:\/|$)/i.test(encoded)
    ) {
      return { error: errorResponse(400, "Bad request") };
    }
    const pathname = decodeURIComponent(encoded);
    return { url, pathname: canonicalPath(pathname, "request path", true) };
  } catch {
    return { error: errorResponse(400, "Bad request") };
  }
}

function canonicalPath(value: unknown, label: string, normalizeTrailingSlash = false): string {
  if (typeof value !== "string") {
    throw new TypeError(`Ferrite Cloudflare ${label} must be a string.`);
  }
  const normalized = normalizeTrailingSlash && value.length > 1
    ? value.replace(/\/+$/, "")
    : value;
  if (
    !normalized.startsWith("/") ||
    normalized.includes("//") ||
    (normalized !== "/" && normalized.endsWith("/")) ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`Ferrite Cloudflare ${label} "${value}" is not a canonical absolute path.`);
  }
  return normalized;
}

function configuredPath(value: unknown, label: string): string {
  const path = canonicalPath(value, label);
  if (path.includes("%")) {
    throw new TypeError(
      `Ferrite Cloudflare ${label} "${path}" cannot contain percent-encoded or literal percent bytes.`,
    );
  }
  return path;
}

async function fetchFallback<Env extends CloudflareSsrEnv>(
  request: Request,
  env: Env,
  fallbackPath: string,
  failureStatus: number,
  responseDeadlineMs: number,
  maxHtmlBytes: number,
): Promise<Response> {
  throwIfAborted(request.signal);
  const binding = env?.ASSETS;
  if (!binding || typeof binding.fetch !== "function") {
    return errorResponse(
      failureStatus,
      failureStatus === 504 ? "Gateway timeout" : "Internal server error",
      {},
      request.method === "HEAD",
    );
  }
  const url = new URL(request.url);
  url.pathname = fallbackPath;
  url.search = "";
  url.hash = "";
  try {
    const deadline = monotonicNow() + responseDeadlineMs;
    const headers = new Headers(request.headers);
    for (const name of [
      "if-match",
      "if-modified-since",
      "if-none-match",
      "if-range",
      "if-unmodified-since",
      "range",
    ]) {
      headers.delete(name);
    }
    const response = await withinRequestBudget(
      binding.fetch(
        new Request(url.toString(), {
          method: request.method,
          headers,
          signal: request.signal,
        }),
      ),
      request.signal,
      deadline,
    );
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (response.status !== 200 || mediaType !== "text/html") {
      return errorResponse(
        failureStatus,
        failureStatus === 504 ? "Gateway timeout" : "Internal server error",
        {},
        request.method === "HEAD",
      );
    }
    const body = request.method === "HEAD"
      ? null
      : await readBoundedResponseBody(
          response,
          maxHtmlBytes,
          "fallback HTML",
          request.signal,
          deadline,
        );
    return new Response(
      body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders("no-cache", {
          ...Object.fromEntries(response.headers),
          "X-Ferrite-Render": "static-fallback",
        }),
      },
    );
  } catch (error) {
    if (request.signal.aborted) {
      throw abortError();
    }
    const status = error instanceof ResponseDeadlineError ? 504 : failureStatus;
    return errorResponse(
      status,
      status === 504 ? "Gateway timeout" : "Internal server error",
      {},
      request.method === "HEAD",
    );
  }
}

async function fetchAsset<Env extends CloudflareSsrEnv>(request: Request, env: Env): Promise<Response> {
  const binding = env?.ASSETS;
  if (!binding || typeof binding.fetch !== "function") {
    return errorResponse(500, "Internal server error");
  }
  try {
    const response = await binding.fetch(request);
    return new Response(
      request.method === "HEAD" || responseStatusForbidsBody(response.status) ? null : response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers.get("cache-control"), response.headers),
      },
    );
  } catch {
    if (request.signal.aborted) {
      throw abortError();
    }
    return errorResponse(500, "Internal server error");
  }
}

async function withinRequestBudget<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  throwIfAborted(signal);
  const remaining = Math.max(0, deadline - monotonicNow());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ResponseDeadlineError()), remaining);
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }),
    ]);
    throwIfAborted(signal);
    ensureBeforeDeadline(deadline);
    return result;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function ensureBeforeDeadline(deadline: number): void {
  if (monotonicNow() >= deadline) {
    throw new ResponseDeadlineError();
  }
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function abortError(): DOMException {
  return new DOMException("Ferrite Cloudflare request was aborted.", "AbortError");
}

function acceptsHtml(accept: string | null): boolean {
  if (!accept || accept.trim() === "") {
    return true;
  }
  return accept
    .split(",")
    .map((value) => {
      const [mediaType, ...parameters] = value.split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(0(?:\.0*)?|1(?:\.0*)?)$/i)?.[1])
        .find((parameter) => parameter !== undefined);
      return {
        mediaType: mediaType?.trim().toLowerCase(),
        quality: quality === undefined ? 1 : Number(quality),
      };
    })
    .some(({ mediaType, quality }) =>
      quality > 0 && (mediaType === "*/*" || mediaType === "text/html")
    );
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`Ferrite Cloudflare ${label} limit must be a positive safe integer.`);
  }
  return candidate;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function responseHeaders(cacheControl: string | null, source: HeadersInit): Headers {
  const headers = new Headers(source);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("Cache-Control", cacheControl || "no-cache");
  return headers;
}

function responseStatusForbidsBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function errorResponse(
  status: number,
  message: string,
  extra: HeadersInit = {},
  head = false,
): Response {
  return new Response(head ? null : message, {
    status,
    headers: responseHeaders("no-store", {
      "Content-Type": "text/plain; charset=utf-8",
      ...Object.fromEntries(new Headers(extra)),
    }),
  });
}
