export * from "./dom-base.js";

import {
  __normalizeAttributeChild,
  type Child,
  type Component,
  type ServerPayloadPacket,
} from "./index.js";
import {
  applyServerPayload as baseApplyServerPayload,
  createServerPayloadNavigator as baseCreateServerPayloadNavigator,
  fetchAndApplyServerPayloadStream as baseFetchAndApplyServerPayloadStream,
  fetchServerPayload as baseFetchServerPayload,
  hydrate as baseHydrate,
  hydrateClientReference as baseHydrateClientReference,
  mount as baseMount,
  type ClientReferenceRegistration,
  type FetchServerPayloadOptions,
  type FetchServerPayloadStreamOptions,
  type RootHandle,
  type ServerPayloadFetch,
  type ServerPayloadNavigateOptions,
  type ServerPayloadNavigationOptions,
  type ServerPayloadNavigator,
} from "./dom-base.js";

const SERVER_PAYLOAD_HISTORY_STATE_KEY = "__ferriteServerPayloadNavigation";

export type ServerPayloadSafetyOptions = {
  maxResponseBytes?: number;
  maxFrameBytes?: number;
  maxFrames?: number;
  maxTreeNodes?: number;
  maxTreeDepth?: number;
  maxPrefetchEntries?: number;
  prefetchTtlMs?: number;
};

type ResolvedSafetyOptions = Required<ServerPayloadSafetyOptions>;
type SafeFetchOptions = FetchServerPayloadOptions & ServerPayloadSafetyOptions;
type SafeStreamOptions = FetchServerPayloadStreamOptions & ServerPayloadSafetyOptions;
type SafeNavigationOptions = ServerPayloadNavigationOptions & ServerPayloadSafetyOptions;
type PrefetchEntry = {
  controller: AbortController;
  expiresAt: number;
  promise: Promise<ServerPayloadPacket>;
};

export function mount(child: Child, container: Element): RootHandle {
  return normalizedRoot(baseMount(__normalizeAttributeChild(child), container));
}

export function hydrate(child: Child, container: Element): RootHandle {
  return normalizedRoot(baseHydrate(__normalizeAttributeChild(child), container));
}

export function hydrateClientReference(
  registration: ClientReferenceRegistration,
  root: ParentNode = globalThis.document,
): RootHandle[] {
  const component = registration.component;
  const normalizedComponent: Component<Record<string, unknown>> = (props) => {
    const rendered = component(props);
    return isPromiseLike(rendered)
      ? rendered.then(__normalizeAttributeChild)
      : __normalizeAttributeChild(rendered);
  };
  return baseHydrateClientReference(
    {
      ...registration,
      component: normalizedComponent,
    },
    root,
  ).map(normalizedRoot);
}

export async function fetchServerPayload(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<ServerPayloadPacket> {
  const safety = resolveSafetyOptions(options);
  const packet = await baseFetchServerPayload(input, {
    fetch: boundedFetch(options.fetch ?? globalThis.fetch, safety, "packet"),
    requestInit: options.requestInit,
  });
  assertPacketBudget(packet, safety);
  return packet;
}

export async function fetchAndApplyServerPayload(
  root: RootHandle,
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<ServerPayloadPacket> {
  const packet = await fetchServerPayload(input, options);
  return baseApplyServerPayload(root, packet);
}

export async function fetchAndApplyServerPayloadStream(
  root: RootHandle,
  input: string | URL,
  options: SafeStreamOptions = {},
): Promise<ServerPayloadPacket> {
  const safety = resolveSafetyOptions(options);
  const packet = await baseFetchAndApplyServerPayloadStream(root, input, {
    fetch: boundedFetch(options.fetch ?? globalThis.fetch, safety, "stream"),
    requestInit: options.requestInit,
    window: options.window,
    routeRootId: options.routeRootId,
    reconcileHead: options.reconcileHead,
    onShell: options.onShell,
    onChunk: options.onChunk,
  });
  assertPacketBudget(packet, safety);
  return packet;
}

export function createServerPayloadNavigator(
  root: RootHandle,
  options: SafeNavigationOptions = {},
): ServerPayloadNavigator {
  if (!root || typeof root.update !== "function") {
    throw new TypeError("Ferrite server payload navigator requires a root handle.");
  }
  const navigationWindow = options.window ?? globalThis.window;
  if (!navigationWindow?.document) {
    throw new TypeError("Ferrite server payload navigator requires a browser window.");
  }
  const eventRoot = options.eventRoot ?? navigationWindow.document;
  if (
    typeof eventRoot.addEventListener !== "function"
    || typeof eventRoot.removeEventListener !== "function"
  ) {
    throw new TypeError("Ferrite server payload navigator event root must support event listeners.");
  }

  const safety = resolveSafetyOptions(options);
  const fallback = options.fallback ?? ((url: URL) => navigationWindow.location.assign(url.href));
  const cache = new Map<string, PrefetchEntry>();
  let activeNavigation: { id: number; controller: AbortController } | null = null;
  let nextNavigationId = 1;
  let destroyed = false;
  seedNavigationHistory(navigationWindow);

  const assertActive = (id: number): void => {
    if (destroyed || activeNavigation?.id !== id) {
      throw abortError("Ferrite navigation was replaced by a newer request.");
    }
  };

  const prefetch = async (input: string | URL): Promise<ServerPayloadPacket | null> => {
    assertNavigatorAlive(destroyed);
    const url = navigationUrl(input, navigationWindow);
    if (!isSameOriginNavigation(url, navigationWindow)) {
      return null;
    }
    purgeExpiredPrefetches(cache);
    const key = url.href;
    const existing = cache.get(key);
    if (existing) {
      cache.delete(key);
      cache.set(key, existing);
      return existing.promise;
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(controller, options.requestInit?.signal);
    const request = fetchServerPayload(url, {
      ...safety,
      fetch: options.fetch,
      requestInit: { ...options.requestInit, signal: controller.signal },
    }).finally(unlink);
    const entry: PrefetchEntry = {
      controller,
      expiresAt: Date.now() + safety.prefetchTtlMs,
      promise: request,
    };
    cache.set(key, entry);
    request.catch(() => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    });
    trimPrefetchCache(cache, safety.maxPrefetchEntries);
    return request;
  };

  const takePrefetch = (url: URL): PrefetchEntry | undefined => {
    purgeExpiredPrefetches(cache);
    const entry = cache.get(url.href);
    if (!entry) {
      return undefined;
    }
    cache.delete(url.href);
    return entry;
  };

  const navigate = async (
    input: string | URL,
    navigateOptions: ServerPayloadNavigateOptions = {},
    updateHistory = true,
  ): Promise<ServerPayloadPacket | null> => {
    assertNavigatorAlive(destroyed);
    const url = navigationUrl(input, navigationWindow);
    if (!isSameOriginNavigation(url, navigationWindow)) {
      return null;
    }

    activeNavigation?.controller.abort(abortError("Ferrite navigation was superseded."));
    const controller = new AbortController();
    const id = nextNavigationId;
    nextNavigationId += 1;
    activeNavigation = { id, controller };
    const unlink = linkAbortSignal(controller, options.requestInit?.signal);
    const prefetched = takePrefetch(url);
    const unlinkPrefetch = prefetched ? linkAbortSignal(prefetched.controller, controller.signal) : () => undefined;

    const guardedRoot: RootHandle = {
      update(nextChild) {
        assertActive(id);
        root.update(nextChild);
      },
      unmount() {
        assertActive(id);
        root.unmount();
      },
    };

    let transient: ServerPayloadNavigator | null = null;
    try {
      const packet = prefetched ? await prefetched.promise : undefined;
      assertActive(id);
      const fetchImpl: ServerPayloadFetch = packet
        ? async () => packetResponse(packet)
        : boundedFetch(options.fetch ?? globalThis.fetch, safety, "auto");
      transient = baseCreateServerPayloadNavigator(guardedRoot, {
        window: navigationWindow,
        eventRoot: navigationWindow.document.createDocumentFragment(),
        routeRootId: options.routeRootId,
        reconcileHead: options.reconcileHead,
        prefetch: false,
        stream: packet ? false : options.stream,
        fetch: fetchImpl,
        requestInit: { ...options.requestInit, signal: controller.signal },
        fallback: () => undefined,
      });
      const result = await transient.navigate(url, {
        replace: navigateOptions.replace,
        fallbackOnError: false,
        history: updateHistory,
      } as ServerPayloadNavigateOptions & { history: boolean });
      assertActive(id);
      return result;
    } catch (error) {
      if (destroyed || activeNavigation?.id !== id) {
        return null;
      }
      options.onError?.(error, url);
      if (navigateOptions.fallbackOnError) {
        fallback(url);
        return null;
      }
      throw error;
    } finally {
      transient?.destroy();
      unlinkPrefetch();
      unlink();
      if (activeNavigation?.id === id) {
        activeNavigation = null;
      }
    }
  };

  const handleClick = (event: Event): void => {
    const url = navigationClickUrl(event, navigationWindow);
    if (!url) {
      return;
    }
    event.preventDefault();
    void navigate(url, { fallbackOnError: true });
  };
  const handleIntent = (event: Event): void => {
    const url = navigationIntentUrl(event, navigationWindow);
    if (url) {
      void prefetch(url).catch(() => undefined);
    }
  };
  const handlePopState = (event: PopStateEvent): void => {
    const url = restoredNavigationUrl(event.state, navigationWindow);
    if (url) {
      void navigate(url, { replace: true, fallbackOnError: true }, false);
    }
  };

  eventRoot.addEventListener("click", handleClick);
  if (options.prefetch === true) {
    eventRoot.addEventListener("pointerover", handleIntent);
    eventRoot.addEventListener("focusin", handleIntent);
  }
  navigationWindow.addEventListener("popstate", handlePopState);

  return {
    prefetch,
    navigate,
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      activeNavigation?.controller.abort(abortError("Ferrite navigator was destroyed."));
      activeNavigation = null;
      for (const entry of cache.values()) {
        entry.controller.abort(abortError("Ferrite prefetch was cancelled."));
      }
      cache.clear();
      eventRoot.removeEventListener("click", handleClick);
      if (options.prefetch === true) {
        eventRoot.removeEventListener("pointerover", handleIntent);
        eventRoot.removeEventListener("focusin", handleIntent);
      }
      navigationWindow.removeEventListener("popstate", handlePopState);
    },
  };
}

function normalizedRoot(root: RootHandle): RootHandle {
  return {
    update(nextChild) {
      root.update(__normalizeAttributeChild(nextChild));
    },
    unmount() {
      root.unmount();
    },
  };
}

function resolveSafetyOptions(options: ServerPayloadSafetyOptions): ResolvedSafetyOptions {
  return {
    maxResponseBytes: positiveInteger(options.maxResponseBytes, 4 * 1024 * 1024, "maxResponseBytes"),
    maxFrameBytes: positiveInteger(options.maxFrameBytes, 512 * 1024, "maxFrameBytes"),
    maxFrames: positiveInteger(options.maxFrames, 256, "maxFrames"),
    maxTreeNodes: positiveInteger(options.maxTreeNodes, 50_000, "maxTreeNodes"),
    maxTreeDepth: positiveInteger(options.maxTreeDepth, 256, "maxTreeDepth"),
    maxPrefetchEntries: positiveInteger(options.maxPrefetchEntries, 32, "maxPrefetchEntries"),
    prefetchTtlMs: positiveInteger(options.prefetchTtlMs, 30_000, "prefetchTtlMs"),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Ferrite ${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedFetch(
  fetchImpl: ServerPayloadFetch,
  safety: ResolvedSafetyOptions,
  mode: "auto" | "packet" | "stream",
): ServerPayloadFetch {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Ferrite server payload fetch requires a fetch implementation.");
  }
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const responseMode = mode === "auto" ? payloadResponseMode(input) : mode;
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > safety.maxResponseBytes) {
      if (response.body && typeof response.body.cancel === "function") {
        await response.body.cancel("Ferrite response byte budget exceeded.").catch(() => undefined);
      }
      throw new RangeError("Ferrite server payload response exceeds maxResponseBytes.");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      if (responseMode === "packet" && typeof response.json === "function") {
        return plainResponse(response, null, async () => {
          const payload = await response.json();
          assertSerializedPacketBudget(payload, safety.maxResponseBytes);
          assertUnknownPacketBudget(payload, safety);
          return payload;
        });
      }
      return response;
    }
    if (responseMode === "packet") {
      const bytes = await readBoundedBody(response.body, safety.maxResponseBytes);
      const text = new TextDecoder().decode(bytes);
      return plainResponse(response, null, async () => {
        const payload = JSON.parse(text);
        assertUnknownPacketBudget(payload, safety);
        return payload;
      });
    }
    return plainResponse(response, boundedFrameStream(response.body, safety), response.json?.bind(response));
  };
}

function payloadResponseMode(input: string): "packet" | "stream" {
  try {
    return new URL(input).searchParams.get("__ferrite_payload") === "stream" ? "stream" : "packet";
  } catch {
    return "packet";
  }
}

function plainResponse(
  response: Response,
  body: ReadableStream<Uint8Array> | null,
  json: (() => Promise<unknown>) | undefined,
): Response {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body,
    json: json ?? (async () => { throw new TypeError("Ferrite response has no JSON body."); }),
  } as Response;
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("Ferrite response byte budget exceeded.");
        throw new RangeError("Ferrite server payload response exceeds maxResponseBytes.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function boundedFrameStream(
  body: ReadableStream<Uint8Array>,
  safety: ResolvedSafetyOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let currentChunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let currentOffset = 0;
  let frameParts: Uint8Array[] = [];
  let totalBytes = 0;
  let frameBytes = 0;
  let frameCount = 0;
  let treeNodes = 0;
  let sourceDone = false;
  let readerReleased = false;

  const releaseReader = (): void => {
    if (!readerReleased) {
      readerReleased = true;
      reader.releaseLock();
    }
  };

  const nextFrameBytes = async (): Promise<Uint8Array | null> => {
    for (;;) {
      if (currentOffset < currentChunk.byteLength) {
        const newline = currentChunk.indexOf(10, currentOffset);
        const end = newline === -1 ? currentChunk.byteLength : newline;
        const part = currentChunk.subarray(currentOffset, end);
        const consumedBytes = part.byteLength + (newline === -1 ? 0 : 1);
        totalBytes += consumedBytes;
        if (totalBytes > safety.maxResponseBytes) {
          throw new RangeError("Ferrite server payload stream exceeds maxResponseBytes.");
        }
        frameBytes += part.byteLength;
        if (frameBytes > safety.maxFrameBytes) {
          throw new RangeError("Ferrite server payload stream frame exceeds maxFrameBytes.");
        }
        if (part.byteLength > 0) {
          frameParts.push(part);
        }
        currentOffset = newline === -1 ? end : end + 1;
        if (newline !== -1) {
          const frame = concatenateBytes(frameParts, frameBytes);
          frameParts = [];
          frameBytes = 0;
          return frame;
        }
        continue;
      }

      if (sourceDone) {
        if (frameBytes === 0) {
          return null;
        }
        const frame = concatenateBytes(frameParts, frameBytes);
        frameParts = [];
        frameBytes = 0;
        return frame;
      }

      const { value, done } = await reader.read();
      if (done) {
        sourceDone = true;
        continue;
      }
      currentChunk = value;
      currentOffset = 0;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const frame = await nextFrameBytes();
          if (frame === null) {
            releaseReader();
            controller.close();
            return;
          }
          const line = decoder.decode(frame).replace(/\r$/, "");
          ({ frameCount, treeNodes } = inspectFrameLine(line, frameCount, treeNodes, safety));
          if (line.trim().length === 0) {
            continue;
          }
          const output = new Uint8Array(frame.byteLength + 1);
          output.set(frame);
          output[frame.byteLength] = 10;
          controller.enqueue(output);
          return;
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}

function concatenateBytes(parts: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function inspectFrameLine(
  line: string,
  frameCount: number,
  treeNodes: number,
  safety: ResolvedSafetyOptions,
): { frameCount: number; treeNodes: number } {
  if (line.trim().length === 0) {
    return { frameCount, treeNodes };
  }
  const nextFrameCount = frameCount + 1;
  if (nextFrameCount > safety.maxFrames) {
    throw new RangeError("Ferrite server payload stream exceeds maxFrames.");
  }
  try {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const node = frame.kind === "shell"
      ? frame.shell
      : frame.kind === "chunk" && frame.chunk && typeof frame.chunk === "object"
        ? (frame.chunk as Record<string, unknown>).root
        : undefined;
    const nextTreeNodes = treeNodes + compactTreeSize(node, safety.maxTreeDepth);
    if (nextTreeNodes > safety.maxTreeNodes) {
      throw new RangeError("Ferrite server payload stream exceeds maxTreeNodes.");
    }
    return { frameCount: nextFrameCount, treeNodes: nextTreeNodes };
  } catch (error) {
    if (error instanceof RangeError) {
      throw error;
    }
    return { frameCount: nextFrameCount, treeNodes };
  }
}

function assertUnknownPacketBudget(payload: unknown, safety: ResolvedSafetyOptions): void {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const record = payload as Record<string, unknown>;
  const chunks = Array.isArray(record.chunks) ? record.chunks : [];
  if (chunks.length + 1 > safety.maxFrames) {
    throw new RangeError("Ferrite server payload exceeds maxFrames.");
  }
  let nodes = compactTreeSize(record.shell, safety.maxTreeDepth);
  if (nodes > safety.maxTreeNodes) {
    throw new RangeError("Ferrite server payload exceeds maxTreeNodes.");
  }
  for (const chunk of chunks) {
    if (chunk !== null && typeof chunk === "object" && !Array.isArray(chunk)) {
      nodes += compactTreeSize((chunk as Record<string, unknown>).root, safety.maxTreeDepth);
      if (nodes > safety.maxTreeNodes) {
        throw new RangeError("Ferrite server payload exceeds maxTreeNodes.");
      }
    }
  }
}

function assertPacketBudget(packet: ServerPayloadPacket, safety: ResolvedSafetyOptions): void {
  if (packet.chunks.length + 1 > safety.maxFrames) {
    throw new RangeError("Ferrite server payload exceeds maxFrames.");
  }
  let nodes = compactTreeSize(packet.shell, safety.maxTreeDepth);
  if (nodes > safety.maxTreeNodes) {
    throw new RangeError("Ferrite server payload exceeds maxTreeNodes.");
  }
  for (const chunk of packet.chunks) {
    nodes += compactTreeSize(chunk.root, safety.maxTreeDepth);
    if (nodes > safety.maxTreeNodes) {
      throw new RangeError("Ferrite server payload exceeds maxTreeNodes.");
    }
  }
}

function assertSerializedPacketBudget(payload: unknown, maximum: number): void {
  const serialized = JSON.stringify(payload);
  if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > maximum) {
    throw new RangeError("Ferrite server payload response exceeds maxResponseBytes.");
  }
}

function compactTreeSize(root: unknown, maximumDepth: number): number {
  if (root === undefined) {
    return 0;
  }
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > maximumDepth) {
      throw new RangeError("Ferrite server payload exceeds maxTreeDepth.");
    }
    count += 1;
    if (!Array.isArray(current.node)) {
      continue;
    }
    const opcode = current.node[0];
    const children = opcode === 1 ? current.node[1] : opcode === 2 ? current.node[3] : undefined;
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], depth: current.depth + 1 });
      }
    }
  }
  return count;
}

function packetResponse(packet: ServerPayloadPacket): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    json: async () => packet,
  } as Response;
}

function purgeExpiredPrefetches(cache: Map<string, PrefetchEntry>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      entry.controller.abort(abortError("Ferrite prefetch expired."));
      cache.delete(key);
    }
  }
}

function trimPrefetchCache(cache: Map<string, PrefetchEntry>, maximum: number): void {
  while (cache.size > maximum) {
    const oldest = cache.entries().next().value as [string, PrefetchEntry] | undefined;
    if (!oldest) {
      return;
    }
    oldest[1].controller.abort(abortError("Ferrite prefetch cache entry was evicted."));
    cache.delete(oldest[0]);
  }
}

function linkAbortSignal(controller: AbortController, signal: AbortSignal | null | undefined): () => void {
  if (!signal) {
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function assertNavigatorAlive(destroyed: boolean): void {
  if (destroyed) {
    throw new TypeError("Ferrite server payload navigator has been destroyed.");
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function navigationUrl(input: string | URL, navigationWindow: Window): URL {
  if (input instanceof URL) {
    return new URL(input.href);
  }
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("Ferrite navigation requires a non-empty URL.");
  }
  return new URL(input, navigationWindow.location.href);
}

function navigationClickUrl(event: Event, navigationWindow: Window): URL | null {
  const candidate = event as Partial<MouseEvent>;
  if (
    event.defaultPrevented
    || typeof candidate.button !== "number"
    || candidate.button !== 0
    || candidate.metaKey
    || candidate.ctrlKey
    || candidate.shiftKey
    || candidate.altKey
  ) {
    return null;
  }
  return navigationAnchorUrl(event.target, navigationWindow);
}

function navigationIntentUrl(event: Event, navigationWindow: Window): URL | null {
  return event.defaultPrevented ? null : navigationAnchorUrl(event.target, navigationWindow);
}

function navigationAnchorUrl(target: EventTarget | null, navigationWindow: Window): URL | null {
  if (!target || !("closest" in target) || typeof target.closest !== "function") {
    return null;
  }
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) {
    return null;
  }
  const targetName = anchor.getAttribute("target");
  if (targetName && targetName.toLowerCase() !== "_self") {
    return null;
  }
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) {
    return null;
  }
  const url = navigationUrl(href, navigationWindow);
  return isSameOriginNavigation(url, navigationWindow) ? url : null;
}

function isSameOriginNavigation(url: URL, navigationWindow: Window): boolean {
  return url.origin === navigationWindow.location.origin && (url.protocol === "http:" || url.protocol === "https:");
}

function seedNavigationHistory(navigationWindow: Window): void {
  const url = new URL(navigationWindow.location.href);
  const restored = restoredNavigationUrl(navigationWindow.history.state, navigationWindow);
  if (restored?.href === url.href) {
    return;
  }
  navigationWindow.history.replaceState(navigationHistoryState(url, navigationWindow.history.state), "", locationPath(url));
}

function navigationHistoryState(url: URL, previous: unknown): Record<string, unknown> {
  const state: Record<string, unknown> = previous !== null && typeof previous === "object" && !Array.isArray(previous)
    ? { ...(previous as Record<string, unknown>) }
    : previous === undefined || previous === null
      ? {}
      : { state: previous };
  state[SERVER_PAYLOAD_HISTORY_STATE_KEY] = { version: 1, url: url.href };
  return state;
}

function restoredNavigationUrl(state: unknown, navigationWindow: Window): URL | null {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const marker = (state as Record<string, unknown>)[SERVER_PAYLOAD_HISTORY_STATE_KEY];
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  const version = (marker as Record<string, unknown>).version;
  const rawUrl = (marker as Record<string, unknown>).url;
  if (version !== 1 || typeof rawUrl !== "string") {
    return null;
  }
  try {
    const url = navigationUrl(rawUrl, navigationWindow);
    return isSameOriginNavigation(url, navigationWindow) && url.href === navigationWindow.location.href ? url : null;
  } catch {
    return null;
  }
}

function locationPath(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

function isPromiseLike(value: unknown): value is Promise<Child> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}
