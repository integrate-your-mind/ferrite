import type {
  DocumentModule,
  DocumentRenderOptions,
  LayoutModule,
  Metadata,
  PageModule,
  RouteConventionModules,
  ServerRenderOptions,
} from "./server.js";
import type { RenderPacket } from "./index.js";

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const DEFAULT_MAX_PACKET_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RENDER_MS = 1_000;

export type CloudflareAssetsBinding = {
  fetch(request: Request): Promise<Response>;
};

export type CloudflareSsrEnv = {
  ASSETS?: CloudflareAssetsBinding;
  [name: string]: unknown;
};

export type CloudflareHtmlRenderer = {
  renderJsonToHtml(json: string, maxOutputBytes?: number): string;
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
};

export type CloudflareSsrRoute = {
  path: string;
  fallbackPath: string;
  module: CloudflareRouteModule;
  props?: Record<string, unknown>;
  observedActions: string[];
  document?: Omit<DocumentRenderOptions, "metadata" | "routePath" | "routePattern">;
};

export type CloudflareSsrOptions<Env extends CloudflareSsrEnv = CloudflareSsrEnv> = {
  routes: CloudflareSsrRoute[];
  renderer: CloudflareHtmlRenderer;
  maxPacketBytes?: number;
  maxHtmlBytes?: number;
  maxRenderMs?: number;
  shouldRender?: (request: Request, env: Env) => boolean;
};

type PreparedRoute = CloudflareSsrRoute & {
  layoutModules: LayoutModule[];
  conventionModules: RouteConventionModules;
  props: Record<string, unknown>;
};

class RenderDeadlineError extends Error {
  constructor() {
    super("Ferrite Cloudflare request-time render exceeded its deadline.");
    this.name = "RenderDeadlineError";
  }
}

export function createCloudflareSsrHandler<Env extends CloudflareSsrEnv = CloudflareSsrEnv>(
  options: CloudflareSsrOptions<Env>,
): { fetch(request: Request, env: Env): Promise<Response> } {
  const routes = prepareRoutes(options.routes);
  const maxPacketBytes = positiveLimit(options.maxPacketBytes, DEFAULT_MAX_PACKET_BYTES, "packet byte");
  const maxHtmlBytes = positiveLimit(options.maxHtmlBytes, DEFAULT_MAX_HTML_BYTES, "HTML byte");
  const maxRenderMs = positiveLimit(options.maxRenderMs, DEFAULT_MAX_RENDER_MS, "render millisecond");
  if (!options.renderer || typeof options.renderer.renderJsonToHtml !== "function") {
    throw new TypeError("Ferrite Cloudflare SSR requires a packet-to-HTML renderer.");
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

      let useSsr = true;
      try {
        useSsr = options.shouldRender?.(request, env) ?? true;
      } catch {
        useSsr = false;
      }
      if (!useSsr) {
        return fetchFallback(request, env, route.fallbackPath, 500);
      }

      const deadline = monotonicNow() + maxRenderMs;
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
        const html = options.renderer.renderJsonToHtml(packetJson, maxHtmlBytes);
        if (byteLength(html) > maxHtmlBytes) {
          throw new TypeError(`Ferrite rendered HTML exceeds the ${maxHtmlBytes}-byte limit.`);
        }
        ensureBeforeDeadline(deadline);
        throwIfAborted(request.signal);

        const body = route.module.documentModule
          ? `<!doctype html>\n${html}`
          : html;
        return new Response(method === "HEAD" ? null : body, {
          status: 200,
          headers: responseHeaders("no-store", {
            "Content-Type": "text/html; charset=utf-8",
            "X-Ferrite-Render": "request",
          }),
        });
      } catch (error) {
        if (isAbortError(error) || request.signal.aborted) {
          throw abortError();
        }
        const status = error instanceof RenderDeadlineError ? 504 : 500;
        return fetchFallback(request, env, route.fallbackPath, status);
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

function prepareRoutes(routes: CloudflareSsrRoute[]): Map<string, PreparedRoute> {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new TypeError("Ferrite Cloudflare SSR requires at least one route.");
  }
  const prepared = new Map<string, PreparedRoute>();
  for (const route of routes) {
    if (!route || typeof route !== "object") {
      throw new TypeError("Ferrite Cloudflare SSR routes must be objects.");
    }
    const path = canonicalPath(route.path, "route path");
    if (path.split("/").some((segment) => segment.startsWith(":") || segment.startsWith("*"))) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" is dynamic; the initial Worker adapter accepts exact routes only.`,
      );
    }
    canonicalPath(route.fallbackPath, `fallback path for "${path}"`);
    if (prepared.has(path)) {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" is duplicated.`);
    }
    if (!route.module || typeof route.module !== "object") {
      throw new TypeError(`Ferrite Cloudflare SSR route "${path}" is missing its module.`);
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
    if (!Array.isArray(route.observedActions)) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" must include its build-observed server action list.`,
      );
    }
    if (route.observedActions.length > 0) {
      throw new TypeError(
        `Ferrite Cloudflare SSR route "${path}" contains server actions, which the initial Worker adapter does not support.`,
      );
    }
    if (route.observedActions.some((action) => typeof action !== "string" || action.length === 0)) {
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
      props: route.props ?? {},
      layoutModules: route.module.layoutModules ?? [],
      conventionModules: route.module.conventionModules ?? {},
    });
  }
  return prepared;
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

async function fetchFallback<Env extends CloudflareSsrEnv>(
  request: Request,
  env: Env,
  fallbackPath: string,
  failureStatus: number,
): Promise<Response> {
  throwIfAborted(request.signal);
  const binding = env?.ASSETS;
  if (!binding || typeof binding.fetch !== "function") {
    return errorResponse(failureStatus, failureStatus === 504 ? "Gateway timeout" : "Internal server error");
  }
  const url = new URL(request.url);
  url.pathname = fallbackPath;
  url.search = "";
  url.hash = "";
  try {
    const response = await binding.fetch(
      new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      }),
    );
    if (![200, 206, 304, 412, 416].includes(response.status)) {
      return errorResponse(failureStatus, failureStatus === 504 ? "Gateway timeout" : "Internal server error");
    }
    return new Response(
      request.method === "HEAD" || responseStatusForbidsBody(response.status) ? null : response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.status === 412 || response.status === 416 ? "no-store" : "no-cache", {
          ...Object.fromEntries(response.headers),
          "X-Ferrite-Render": "static-fallback",
        }),
      },
    );
  } catch (error) {
    if (isAbortError(error) || request.signal.aborted) {
      throw abortError();
    }
    return errorResponse(failureStatus, failureStatus === 504 ? "Gateway timeout" : "Internal server error");
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
  } catch (error) {
    if (isAbortError(error) || request.signal.aborted) {
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
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new RenderDeadlineError()), remaining);
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }),
    ]);
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
  if (monotonicNow() > deadline) {
    throw new RenderDeadlineError();
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

function errorResponse(status: number, message: string, extra: HeadersInit = {}): Response {
  return new Response(message, {
    status,
    headers: responseHeaders("no-store", {
      "Content-Type": "text/plain; charset=utf-8",
      ...Object.fromEntries(new Headers(extra)),
    }),
  });
}
