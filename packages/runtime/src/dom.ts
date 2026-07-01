import {
  __isTransitionScopeActive,
  __withSchedulerRender,
  ErrorBoundary,
  Fragment,
  Suspense,
  createElement,
  isVNode,
  renderErrorBoundaryFallback,
  startTransition,
  unstable_scheduleCallback,
  unstable_shouldYield,
  withHookDispatcher,
  type Child,
  type Component,
  type EffectCallback,
  type EffectDependencyList,
  type ErrorBoundaryProps,
  type HookDispatcher,
  type MemoDependencyList,
  type RefObject,
  type SchedulerPriority,
  type StateUpdater,
  type TransitionScope,
  type TransitionStartFunction,
  type VNode,
} from "./index.js";
import {
  COMPACT_ELEMENT_OPCODE,
  COMPACT_FRAGMENT_OPCODE,
  COMPACT_TEXT_OPCODE,
  parseClientReferenceId,
  validateClientReferenceParts,
  validateClientReferencePayload,
  validateServerPayloadPacket,
} from "./protocol.js";
import type { CompactNode, ServerPayloadChunk, ServerPayloadPacket } from "./protocol.js";

type HookState = unknown[];
type EffectPhase = "layout" | "passive";
type EffectState = {
  kind: "effect";
  phase: EffectPhase;
  deps?: EffectDependencyList;
  cleanup?: () => void;
};
type MemoState<T = unknown> = {
  kind: "memo";
  deps?: MemoDependencyList;
  value: T;
};
type TransitionState = {
  kind: "transition";
  pending: boolean;
};
type DeferredState<T = unknown> = {
  kind: "deferred";
  value: T;
  pendingValue?: T;
};
type ErrorBoundaryState = {
  error?: unknown;
};
type TransitionUpdate = () => void;
type TransitionRenderSnapshot = {
  hookState: Map<string, HookState>;
  errorBoundaryState: Map<string, ErrorBoundaryState>;
};
type PendingEffect = {
  phase: EffectPhase;
  componentPath: string;
  hookIndex: number;
  effect: EffectCallback;
  deps?: EffectDependencyList;
};

class RenderYield extends Error {
  constructor() {
    super("Ferrite render yielded to higher-priority work.");
    this.name = "RenderYield";
  }
}

export interface RootHandle {
  update(nextChild: Child): void;
  unmount(): void;
}

export type ClientReferenceRegistration = {
  id: string;
  module?: string;
  exportName?: string;
  component: Component<Record<string, unknown>>;
};

export type ServerPayloadFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type FetchServerPayloadOptions = {
  fetch?: ServerPayloadFetch;
  requestInit?: RequestInit;
};

export function mount(child: Child, container: Element): RootHandle {
  if (!container.ownerDocument) {
    throw new TypeError("Ferrite mount requires a container attached to a document.");
  }

  const root = new DomRoot(child, container);
  root.render();

  return {
    update(nextChild) {
      root.update(nextChild);
    },
    unmount() {
      root.unmount();
    },
  };
}

export function serverPayloadRequestUrl(input: string | URL): string {
  if (input instanceof URL) {
    const url = new URL(input.href);
    url.searchParams.set("__ferrite_payload", "server");
    return url.toString();
  }

  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("Ferrite server payload request URL requires a non-empty string or URL.");
  }

  const hashIndex = input.indexOf("#");
  const withoutHash = hashIndex === -1 ? input : input.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : input.slice(hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);
  const params = query
    .split("&")
    .filter((pair) => pair.length > 0)
    .filter((pair) => pair.split("=", 1)[0] !== "__ferrite_payload");
  params.push("__ferrite_payload=server");
  return `${path}?${params.join("&")}${hash}`;
}

export async function fetchServerPayload(
  input: string | URL,
  options: FetchServerPayloadOptions = {},
): Promise<ServerPayloadPacket> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Ferrite server payload fetch requires a fetch implementation.");
  }

  const response = await fetchImpl(serverPayloadRequestUrl(input), options.requestInit);
  if (!response.ok) {
    throw new Error(
      `Ferrite server payload request failed with ${response.status} ${response.statusText || "Unknown Status"}.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new TypeError(
      `Ferrite server payload response must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validateServerPayloadPacket(payload);
}

export function compactNodeToChild(node: CompactNode): Child {
  return compactNodeToChildWithChunks(node, new Map(), new Set(), "root");
}

export function serverPayloadToChild(payload: unknown): Child {
  const packet = validateServerPayloadPacket(payload);
  return validatedServerPayloadToChild(packet);
}

export function applyServerPayload(root: RootHandle, payload: unknown): ServerPayloadPacket {
  if (!root || typeof root.update !== "function") {
    throw new TypeError("Ferrite server payload application requires a root handle.");
  }

  const packet = validateServerPayloadPacket(payload);
  const child = validatedServerPayloadToChild(packet);
  root.update(child);
  return packet;
}

export async function fetchAndApplyServerPayload(
  root: RootHandle,
  input: string | URL,
  options: FetchServerPayloadOptions = {},
): Promise<ServerPayloadPacket> {
  const packet = await fetchServerPayload(input, options);
  return applyServerPayload(root, packet);
}

export function hydrateClientReference(
  registration: ClientReferenceRegistration,
  root: ParentNode = globalThis.document,
): RootHandle[] {
  normalizeClientReferenceRegistration(registration);

  if (typeof registration.component !== "function") {
    throw new TypeError("Ferrite client reference registration requires a component function.");
  }

  if (!root || typeof root.querySelectorAll !== "function") {
    throw new TypeError("Ferrite client reference hydration requires a DOM root.");
  }

  const handles: RootHandle[] = [];
  for (const container of clientReferenceContainers(root, registration.id)) {
    if (container.getAttribute("data-ferrite-client-hydrated") === "true") {
      continue;
    }

    const props = clientReferenceProps(container, registration.id);
    const handle = hydrate(createElement(registration.component, props), container);
    container.setAttribute("data-ferrite-client-hydrated", "true");
    handles.push(handle);
  }

  return handles;
}

export function hydrate(child: Child, container: Element): RootHandle {
  if (!container.ownerDocument) {
    throw new TypeError("Ferrite hydrate requires a container attached to a document.");
  }

  const root = new DomRoot(child, container);
  root.hydrate();

  return {
    update(nextChild) {
      root.update(nextChild);
    },
    unmount() {
      root.unmount();
    },
  };
}

function clientReferenceContainers(root: ParentNode, id: string): Element[] {
  const containers = Array.from(root.querySelectorAll("[data-ferrite-client-reference]"));
  if (isElement(root) && root.hasAttribute("data-ferrite-client-reference")) {
    containers.unshift(root);
  }

  return containers.filter((container) => container.getAttribute("data-ferrite-client-reference") === id);
}

function normalizeClientReferenceRegistration(registration: ClientReferenceRegistration): void {
  if (!registration || typeof registration.id !== "string" || registration.id.length === 0) {
    throw new TypeError("Ferrite client reference registration requires a non-empty id.");
  }

  parseClientReferenceId(registration.id);

  if (registration.module !== undefined || registration.exportName !== undefined) {
    if (typeof registration.module !== "string" || typeof registration.exportName !== "string") {
      throw new TypeError("Ferrite client reference registration module and exportName must be strings.");
    }
    validateClientReferenceParts(registration.id, registration.module, registration.exportName);
  }
}

function clientReferenceProps(container: Element, expectedId: string): Record<string, unknown> {
  const rawPayload = container.getAttribute("data-ferrite-client-payload");
  if (rawPayload !== null && rawPayload !== "") {
    let payload: unknown;
    try {
      payload = JSON.parse(rawPayload);
    } catch (error) {
      throw new TypeError(
        `Ferrite client reference payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const validated = validateClientReferencePayload(payload);
    if (validated.id !== expectedId) {
      throw new TypeError(`Ferrite client reference payload id "${validated.id}" does not match marker "${expectedId}".`);
    }

    return validated.props;
  }

  const raw = container.getAttribute("data-ferrite-client-props");
  if (raw === null || raw === "") {
    return {};
  }

  let props: unknown;
  try {
    props = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `Ferrite client reference props must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    throw new TypeError("Ferrite client reference props must be a JSON object.");
  }

  return props as Record<string, unknown>;
}

function isElement(value: ParentNode): value is Element {
  return (
    typeof (value as Element).getAttribute === "function" &&
    typeof (value as Element).hasAttribute === "function" &&
    typeof (value as Element).setAttribute === "function"
  );
}

function validatedServerPayloadToChild(packet: ServerPayloadPacket): Child {
  const chunks = new Map<string, ServerPayloadChunk>();
  for (const chunk of packet.chunks) {
    if (chunks.has(chunk.id)) {
      throw new TypeError(`Ferrite server payload contains duplicate chunk id "${chunk.id}".`);
    }
    chunks.set(chunk.id, chunk);
  }

  const usedChunks = new Set<string>();
  const child = compactNodeToChildWithChunks(packet.shell, chunks, usedChunks, "shell");
  for (const chunk of chunks.keys()) {
    if (!usedChunks.has(chunk)) {
      throw new TypeError(`Ferrite server payload chunk "${chunk}" has no matching suspense boundary.`);
    }
  }
  return child;
}

function compactNodeToChildWithChunks(
  node: unknown,
  chunks: Map<string, ServerPayloadChunk>,
  usedChunks: Set<string>,
  path: string,
): Child {
  if (!Array.isArray(node) || node.length === 0) {
    throw new TypeError(`Ferrite compact node at ${path} must be a non-empty array.`);
  }

  const opcode = node[0];
  if (opcode === COMPACT_TEXT_OPCODE) {
    if (node.length !== 2 || typeof node[1] !== "string") {
      throw new TypeError(`Ferrite compact text node at ${path} is malformed.`);
    }
    return node[1];
  }

  if (opcode === COMPACT_FRAGMENT_OPCODE) {
    if (node.length !== 2 || !Array.isArray(node[1])) {
      throw new TypeError(`Ferrite compact fragment node at ${path} is malformed.`);
    }
    return node[1].map((child, index) => compactNodeToChildWithChunks(child, chunks, usedChunks, `${path}.${index}`));
  }

  if (opcode === COMPACT_ELEMENT_OPCODE) {
    if (node.length !== 4 || typeof node[1] !== "string" || !Array.isArray(node[3])) {
      throw new TypeError(`Ferrite compact element node at ${path} is malformed.`);
    }

    const props = compactProps(node[2], path);
    const boundary = props["data-ferrite-suspense-boundary"];
    if (typeof boundary === "string") {
      const chunk = chunks.get(boundary);
      if (chunk) {
        usedChunks.add(boundary);
        return compactNodeToChildWithChunks(chunk.root, chunks, usedChunks, `${path}.chunk(${boundary})`);
      }
    }

    const children = node[3].map((child, index) =>
      compactNodeToChildWithChunks(child, chunks, usedChunks, `${path}.children.${index}`),
    );
    return createElement(node[1], props, children);
  }

  throw new TypeError(`Ferrite compact node at ${path} has unsupported opcode ${String(opcode)}.`);
}

function compactProps(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Ferrite compact element props at ${path} must be an object.`);
  }

  const props: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(value)) {
    if (name === "children" || name === "key" || name.startsWith("on")) {
      throw new TypeError(`Ferrite server payload prop "${name}" at ${path} cannot be applied to the DOM.`);
    }

    if (typeof prop !== "string" && typeof prop !== "number" && typeof prop !== "boolean") {
      throw new TypeError(`Ferrite compact element prop "${name}" at ${path} must be a string, number, or boolean.`);
    }

    props[name] = prop;
  }

  return props;
}

class DomRoot {
  private child: Child;
  private readonly container: Element;
  private readonly document: Document;
  private readonly eventHandlers = new WeakMap<Element, Map<string, EventListener>>();
  private readonly nodeKeys = new WeakMap<Node, string>();
  private readonly hookState = new Map<string, HookState>();
  private errorBoundaryState = new Map<string, ErrorBoundaryState>();
  private renderedComponentPaths = new Set<string>();
  private renderedErrorBoundaryPaths = new Set<string>();
  private nextComponentPaths = new Set<string>();
  private nextErrorBoundaryPaths = new Set<string>();
  private pendingLayoutEffects: PendingEffect[] = [];
  private pendingPassiveEffects: PendingEffect[] = [];
  private transitionUpdates: TransitionUpdate[] = [];
  private transitionFlushScheduled = false;
  private transitionFlushCancel: (() => void) | null = null;
  private transitionRenderSnapshot: TransitionRenderSnapshot | null = null;
  private activeComponentPath: string | null = null;
  private activeHookIndex = 0;
  private mounted = true;

  constructor(child: Child, container: Element) {
    this.child = child;
    this.container = container;
    this.document = container.ownerDocument;
  }

  render(): void {
    this.assertMounted();
    this.commitRender();
  }

  hydrate(): void {
    this.assertMounted();
    this.withPendingCommit(() => {
      const cursor = new HydrationCursor(Array.from(this.container.childNodes), "root");
      this.hydrateChild(this.child, cursor, "0");
      cursor.assertDone();
    });
  }

  update(nextChild: Child): void {
    this.assertMounted();
    this.child = nextChild;
    this.commitRender();
  }

  unmount(): void {
    if (!this.mounted) {
      return;
    }

    this.cleanupAllEffects();
    this.container.replaceChildren();
    this.hookState.clear();
    this.errorBoundaryState.clear();
    this.renderedComponentPaths.clear();
    this.renderedErrorBoundaryPaths.clear();
    this.pendingLayoutEffects = [];
    this.pendingPassiveEffects = [];
    this.transitionUpdates = [];
    this.transitionFlushCancel?.();
    this.transitionFlushScheduled = false;
    this.transitionFlushCancel = null;
    this.transitionRenderSnapshot = null;
    this.mounted = false;
  }

  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>] {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error("Ferrite useState can only be called while rendering a component.");
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    if (hookIndex >= hooks.length) {
      hooks[hookIndex] = typeof initial === "function" ? (initial as () => S)() : initial;
    }

    const setState: StateUpdater<S> = (next) => {
      this.assertMounted();

      const applyUpdate = () => {
        const currentHooks = this.hookState.get(componentPath);
        if (!currentHooks) {
          throw new Error("Ferrite state update target no longer exists.");
        }

        const previous = currentHooks[hookIndex] as S;
        currentHooks[hookIndex] = typeof next === "function" ? (next as (previous: S) => S)(previous) : next;
      };

      if (__isTransitionScopeActive()) {
        this.enqueueTransitionUpdate(applyUpdate);
      } else {
        applyUpdate();
        this.commitRender();
      }
    };

    return [hooks[hookIndex] as S, setState];
  }

  useEffect(effect: EffectCallback, deps?: EffectDependencyList): void {
    this.enqueueEffect("passive", effect, deps, "useEffect");
  }

  useLayoutEffect(effect: EffectCallback, deps?: EffectDependencyList): void {
    this.enqueueEffect("layout", effect, deps, "useLayoutEffect");
  }

  private enqueueEffect(
    phase: EffectPhase,
    effect: EffectCallback,
    deps: EffectDependencyList | undefined,
    hookName: "useEffect" | "useLayoutEffect",
  ): void {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error(`Ferrite ${hookName} can only be called while rendering a component.`);
    }

    if (typeof effect !== "function") {
      throw new TypeError(`Ferrite ${hookName} requires an effect function.`);
    }

    if (deps !== undefined && !Array.isArray(deps)) {
      throw new TypeError(`Ferrite ${hookName} dependencies must be an array when provided.`);
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    const previous = asEffectState(hooks[hookIndex]);
    if (previous?.phase !== phase || shouldRunEffect(previous?.deps, deps)) {
      const pending = {
        phase,
        componentPath,
        hookIndex,
        effect,
        deps: deps === undefined ? undefined : [...deps],
      } satisfies PendingEffect;
      if (phase === "layout") {
        this.pendingLayoutEffects.push(pending);
      } else {
        this.pendingPassiveEffects.push(pending);
      }
    }
  }

  useRef<T>(initial: T): RefObject<T> {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error("Ferrite useRef can only be called while rendering a component.");
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    if (hookIndex >= hooks.length) {
      hooks[hookIndex] = { current: initial } satisfies RefObject<T>;
    }

    return hooks[hookIndex] as RefObject<T>;
  }

  useMemo<T>(factory: () => T, deps?: MemoDependencyList): T {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error("Ferrite useMemo can only be called while rendering a component.");
    }

    if (typeof factory !== "function") {
      throw new TypeError("Ferrite useMemo requires a factory function.");
    }

    if (deps !== undefined && !Array.isArray(deps)) {
      throw new TypeError("Ferrite useMemo dependencies must be an array when provided.");
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    const previous = asMemoState<T>(hooks[hookIndex]);
    if (previous && !depsChanged(previous.deps, deps)) {
      return previous.value;
    }

    const value = factory();
    hooks[hookIndex] = {
      kind: "memo",
      deps: deps === undefined ? undefined : [...deps],
      value,
    } satisfies MemoState<T>;
    return value;
  }

  useTransition(): [boolean, TransitionStartFunction] {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error("Ferrite useTransition can only be called while rendering a component.");
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    if (!asTransitionState(hooks[hookIndex])) {
      hooks[hookIndex] = {
        kind: "transition",
        pending: false,
      } satisfies TransitionState;
    }

    const state = hooks[hookIndex] as TransitionState;
    const start: TransitionStartFunction = (scope) => this.startRootTransition(state, scope);
    return [state.pending, start];
  }

  useDeferredValue<T>(value: T): T {
    this.assertMounted();

    if (this.activeComponentPath === null) {
      throw new Error("Ferrite useDeferredValue can only be called while rendering a component.");
    }

    const componentPath = this.activeComponentPath;
    const hookIndex = this.activeHookIndex;
    this.activeHookIndex += 1;

    let hooks = this.hookState.get(componentPath);
    if (!hooks) {
      hooks = [];
      this.hookState.set(componentPath, hooks);
    }

    const previous = asDeferredState<T>(hooks[hookIndex]);
    if (!previous) {
      hooks[hookIndex] = {
        kind: "deferred",
        value,
      } satisfies DeferredState<T>;
      return value;
    }

    if (!Object.is(previous.value, value) && !Object.is(previous.pendingValue, value)) {
      previous.pendingValue = value;
      this.enqueueTransitionUpdate(() => {
        if ("pendingValue" in previous) {
          previous.value = previous.pendingValue as T;
          delete previous.pendingValue;
        }
      });
    }

    return previous.value;
  }

  private renderChild(child: Child, path: string): Node[] {
    this.assertRenderCanContinue();

    if (child === null || child === undefined || typeof child === "boolean") {
      return [];
    }

    if (typeof child === "string" || typeof child === "number") {
      return [this.document.createTextNode(String(child))];
    }

    if (isPromiseLike(child)) {
      throw new TypeError("Ferrite DOM rendering does not support async children yet.");
    }

    if (Array.isArray(child)) {
      return child.flatMap((item, index) => this.renderChild(item, `${path}.${index}`));
    }

    if (!isVNode(child)) {
      throw new TypeError("Ferrite can only mount primitives, arrays, and VNodes.");
    }

    return this.renderVNode(child, path);
  }

  private renderVNode(vnode: VNode, path: string): Node[] {
    if (vnode.type === Fragment) {
      return this.renderChild(vnode.props.children, `${path}.fragment`);
    }

    if (vnode.type === ErrorBoundary) {
      return this.renderErrorBoundary(vnode, path);
    }

    if (vnode.type === Suspense) {
      return this.renderChild(vnode.props.children, `${path}.suspense`);
    }

    if (typeof vnode.type === "function") {
      const component = vnode.type;
      const componentPath = this.componentPath(path, component.name || "Component", vnode.key);
      this.nextComponentPaths.add(componentPath);
      const previousPath = this.activeComponentPath;
      const previousHookIndex = this.activeHookIndex;
      this.activeComponentPath = componentPath;
      this.activeHookIndex = 0;

      try {
        return withHookDispatcher(this, () => {
          const rendered = component(vnode.props);
          if (isPromiseLike(rendered)) {
            throw new TypeError("Ferrite DOM rendering does not support async components yet.");
          }
          return this.renderChild(rendered, `${componentPath}.render`);
        });
      } finally {
        this.activeComponentPath = previousPath;
        this.activeHookIndex = previousHookIndex;
      }
    }

    if (typeof vnode.type !== "string") {
      throw new TypeError("Ferrite cannot mount this element type.");
    }

    const element = this.document.createElement(vnode.type);
    this.setNodeKey(element, vnode.key);
    this.applyProps(element, vnode.props);
    element.append(...this.renderChild(vnode.props.children, `${path}.children`));
    return [element];
  }

  private renderErrorBoundary(vnode: VNode, path: string): Node[] {
    const props = vnode.props as ErrorBoundaryProps;
    if (props.fallback === undefined) {
      throw new TypeError("Ferrite ErrorBoundary requires a fallback prop.");
    }

    const boundaryPath = this.errorBoundaryPath(path, vnode.key);
    this.nextErrorBoundaryPaths.add(boundaryPath);
    let state = this.errorBoundaryState.get(boundaryPath);
    if (!state) {
      state = {};
      this.errorBoundaryState.set(boundaryPath, state);
    }

    const reset = () => this.resetErrorBoundary(boundaryPath);
    if ("error" in state) {
      return this.renderChild(
        renderErrorBoundaryFallback(props.fallback, state.error, reset),
        `${boundaryPath}.fallback`,
      );
    }

    try {
      return this.renderChild(props.children, `${boundaryPath}.children`);
    } catch (error) {
      state.error = error;
      return this.renderChild(renderErrorBoundaryFallback(props.fallback, error, reset), `${boundaryPath}.fallback`);
    }
  }

  private hydrateChild(child: Child, cursor: HydrationCursor, path: string): void {
    if (child === null || child === undefined || typeof child === "boolean") {
      return;
    }

    if (typeof child === "string" || typeof child === "number") {
      const expected = String(child);
      cursor.consumeText(expected);
      return;
    }

    if (isPromiseLike(child)) {
      throw new TypeError("Ferrite hydration does not support async children yet.");
    }

    if (Array.isArray(child)) {
      child.forEach((item, index) => this.hydrateChild(item, cursor, `${path}.${index}`));
      return;
    }

    if (!isVNode(child)) {
      throw new TypeError("Ferrite can only hydrate primitives, arrays, and VNodes.");
    }

    this.hydrateVNode(child, cursor, path);
  }

  private hydrateVNode(vnode: VNode, cursor: HydrationCursor, path: string): void {
    if (vnode.type === Fragment) {
      this.hydrateChild(vnode.props.children, cursor, `${path}.fragment`);
      return;
    }

    if (vnode.type === ErrorBoundary) {
      this.hydrateErrorBoundary(vnode, cursor, path);
      return;
    }

    if (vnode.type === Suspense) {
      this.hydrateChild(vnode.props.children, cursor, `${path}.suspense`);
      return;
    }

    if (typeof vnode.type === "function") {
      const component = vnode.type;
      const componentPath = this.componentPath(path, component.name || "Component", vnode.key);
      this.nextComponentPaths.add(componentPath);
      const previousPath = this.activeComponentPath;
      const previousHookIndex = this.activeHookIndex;
      this.activeComponentPath = componentPath;
      this.activeHookIndex = 0;

      try {
        withHookDispatcher(this, () => {
          const rendered = component(vnode.props);
          if (isPromiseLike(rendered)) {
            throw new TypeError("Ferrite hydration does not support async components yet.");
          }
          this.hydrateChild(rendered, cursor, `${componentPath}.render`);
        });
      } finally {
        this.activeComponentPath = previousPath;
        this.activeHookIndex = previousHookIndex;
      }
      return;
    }

    if (typeof vnode.type !== "string") {
      throw new TypeError("Ferrite cannot hydrate this element type.");
    }

    const node = cursor.next(`<${vnode.type}>`);
    if (node.nodeType !== 1) {
      throw new Error(`Ferrite hydration expected <${vnode.type}> at ${cursor.label}.`);
    }

    const element = node as Element;
    if (element.localName !== vnode.type.toLowerCase()) {
      throw new Error(`Ferrite hydration expected <${vnode.type}> at ${cursor.label}, found <${element.localName}>.`);
    }

    this.applyHydratedProps(element, vnode.props);

    const childCursor = new HydrationCursor(Array.from(element.childNodes), `<${vnode.type}>`);
    this.hydrateChild(vnode.props.children, childCursor, `${path}.children`);
    childCursor.assertDone();
  }

  private hydrateErrorBoundary(vnode: VNode, cursor: HydrationCursor, path: string): void {
    const props = vnode.props as ErrorBoundaryProps;
    if (props.fallback === undefined) {
      throw new TypeError("Ferrite ErrorBoundary requires a fallback prop.");
    }

    const boundaryPath = this.errorBoundaryPath(path, vnode.key);
    this.nextErrorBoundaryPaths.add(boundaryPath);
    let state = this.errorBoundaryState.get(boundaryPath);
    if (!state) {
      state = {};
      this.errorBoundaryState.set(boundaryPath, state);
    }

    const reset = () => this.resetErrorBoundary(boundaryPath);
    if ("error" in state) {
      this.hydrateChild(renderErrorBoundaryFallback(props.fallback, state.error, reset), cursor, `${boundaryPath}.fallback`);
      return;
    }

    try {
      this.hydrateChild(props.children, cursor, `${boundaryPath}.children`);
    } catch (error) {
      state.error = error;
      this.hydrateChild(renderErrorBoundaryFallback(props.fallback, error, reset), cursor, `${boundaryPath}.fallback`);
    }
  }

  private applyProps(element: Element, props: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(props)) {
      if (name === "children" || name === "key") {
        continue;
      }

      if (name.startsWith("on")) {
        this.applyEventProp(element, name, value);
      } else {
        this.applyAttributeProp(element, name, value);
      }
    }
  }

  private applyEventProp(element: Element, name: string, value: unknown): void {
    if (value === null || value === undefined || value === false) {
      return;
    }

    if (typeof value !== "function") {
      throw new TypeError(`Ferrite event prop "${name}" must be a function.`);
    }

    const eventName = eventNameFromProp(name);
    if (!eventName) {
      throw new TypeError(`Ferrite event prop "${name}" is invalid.`);
    }

    this.setEventHandler(element, eventName, value as EventListener);
  }

  private applyAttributeProp(element: Element, name: string, value: unknown): void {
    if (value === null || value === undefined || value === false) {
      return;
    }

    const attributeName = attributeNameFromProp(name);

    if (value === true) {
      element.setAttribute(attributeName, "");
      return;
    }

    if (typeof value === "string" || typeof value === "number") {
      element.setAttribute(attributeName, String(value));
      return;
    }

    throw new TypeError(`Ferrite prop "${name}" must be a string, number, boolean, null, or undefined.`);
  }

  private applyHydratedProps(element: Element, props: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(props)) {
      if (name === "children" || name === "key") {
        continue;
      }

      if (name.startsWith("on")) {
        this.applyEventProp(element, name, value);
      } else {
        this.assertHydratedAttribute(element, name, value);
      }
    }
  }

  private assertHydratedAttribute(element: Element, name: string, value: unknown): void {
    const attributeName = attributeNameFromProp(name);

    if (value === null || value === undefined || value === false) {
      if (element.hasAttribute(attributeName)) {
        throw new Error(`Ferrite hydration unexpected attribute "${attributeName}".`);
      }
      return;
    }

    if (value === true) {
      if (!element.hasAttribute(attributeName)) {
        throw new Error(`Ferrite hydration missing boolean attribute "${attributeName}".`);
      }
      return;
    }

    if (typeof value === "string" || typeof value === "number") {
      const actual = element.getAttribute(attributeName);
      const expected = String(value);
      if (actual !== expected) {
        throw new Error(`Ferrite hydration attribute mismatch for "${attributeName}": expected "${expected}".`);
      }
      return;
    }

    throw new TypeError(`Ferrite prop "${name}" must be a string, number, boolean, null, or undefined.`);
  }

  private assertMounted(): void {
    if (!this.mounted) {
      throw new Error("Ferrite root is unmounted.");
    }
  }

  private assertRenderCanContinue(): void {
    if (unstable_shouldYield()) {
      throw new RenderYield();
    }
  }

  private commitRender(priority: SchedulerPriority = "sync"): void {
    this.withPendingCommit(() => {
      const nextNodes = __withSchedulerRender(priority, () => this.renderChild(this.child, "0"));
      this.patchChildren(this.container, nextNodes);
    });
  }

  private startRootTransition(state: TransitionState, scope: TransitionScope): void {
    this.assertMounted();

    if (!state.pending) {
      state.pending = true;
      this.commitRender();
    }

    startTransition(scope);
    this.scheduleTransitionFlush();
  }

  private enqueueTransitionUpdate(update: TransitionUpdate): void {
    this.transitionUpdates.push(update);
    this.scheduleTransitionFlush();
  }

  private scheduleTransitionFlush(): void {
    if (this.transitionFlushScheduled) {
      return;
    }

    this.transitionFlushScheduled = true;
    this.transitionFlushCancel = unstable_scheduleCallback("transition", () => this.flushTransitionUpdates());
  }

  private flushTransitionUpdates(): void {
    if (!this.mounted) {
      return;
    }

    const updates = this.transitionUpdates;
    this.transitionUpdates = [];
    this.transitionFlushScheduled = false;
    this.transitionFlushCancel = null;

    try {
      for (const update of updates) {
        update();
      }
      this.ensureTransitionRenderSnapshot();
      this.clearPendingTransitions();
      this.commitRender("transition");
      this.transitionRenderSnapshot = null;
    } catch (error) {
      if (isRenderYield(error)) {
        this.restoreTransitionRenderSnapshot();
        this.scheduleTransitionFlush();
        return;
      }

      this.transitionRenderSnapshot = null;
      this.clearPendingTransitions();
      try {
        this.commitRender();
      } catch {
        // Preserve the original transition error below.
      }
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  private clearPendingTransitions(): void {
    for (const hooks of this.hookState.values()) {
      for (const hook of hooks) {
        const transition = asTransitionState(hook);
        if (transition) {
          transition.pending = false;
        }
      }
    }
  }

  private ensureTransitionRenderSnapshot(): void {
    if (this.transitionRenderSnapshot) {
      return;
    }

    this.transitionRenderSnapshot = {
      hookState: cloneHookState(this.hookState),
      errorBoundaryState: cloneErrorBoundaryState(this.errorBoundaryState),
    };
  }

  private restoreTransitionRenderSnapshot(): void {
    if (!this.transitionRenderSnapshot) {
      return;
    }

    this.hookState.clear();
    for (const [path, hooks] of this.transitionRenderSnapshot.hookState) {
      this.hookState.set(path, hooks);
    }
    this.errorBoundaryState = cloneErrorBoundaryState(this.transitionRenderSnapshot.errorBoundaryState);
    this.transitionRenderSnapshot = null;
  }

  private withPendingCommit(commit: () => void): void {
    const previousPendingLayoutEffects = this.pendingLayoutEffects;
    const previousPendingPassiveEffects = this.pendingPassiveEffects;
    const previousNextComponentPaths = this.nextComponentPaths;
    const previousNextErrorBoundaryPaths = this.nextErrorBoundaryPaths;
    const previousErrorBoundaryState = cloneErrorBoundaryState(this.errorBoundaryState);
    this.pendingLayoutEffects = [];
    this.pendingPassiveEffects = [];
    this.nextComponentPaths = new Set();
    this.nextErrorBoundaryPaths = new Set();

    try {
      commit();
      this.cleanupRemovedComponents(this.nextComponentPaths);
      this.cleanupRemovedErrorBoundaries(this.nextErrorBoundaryPaths);
      this.renderedComponentPaths = this.nextComponentPaths;
      this.renderedErrorBoundaryPaths = this.nextErrorBoundaryPaths;
      this.nextComponentPaths = new Set();
      this.nextErrorBoundaryPaths = new Set();
      const layoutEffects = this.pendingLayoutEffects;
      const passiveEffects = this.pendingPassiveEffects;
      this.pendingLayoutEffects = [];
      this.pendingPassiveEffects = [];
      this.flushPendingEffects(layoutEffects);
      this.flushPendingEffects(passiveEffects);
    } catch (error) {
      this.pendingLayoutEffects = previousPendingLayoutEffects;
      this.pendingPassiveEffects = previousPendingPassiveEffects;
      this.nextComponentPaths = previousNextComponentPaths;
      this.nextErrorBoundaryPaths = previousNextErrorBoundaryPaths;
      this.errorBoundaryState = previousErrorBoundaryState;
      throw error;
    }
  }

  private flushPendingEffects(effects: PendingEffect[]): void {
    for (const pending of effects) {
      const hooks = this.hookState.get(pending.componentPath);
      if (!hooks) {
        continue;
      }

      const previous = asEffectState(hooks[pending.hookIndex]);
      previous?.cleanup?.();

      const cleanup = pending.effect();
      if (cleanup !== undefined && typeof cleanup !== "function") {
        throw new TypeError("Ferrite useEffect cleanup must be a function or undefined.");
      }
      const nextCleanup = typeof cleanup === "function" ? cleanup : undefined;

      hooks[pending.hookIndex] = {
        kind: "effect",
        phase: pending.phase,
        deps: pending.deps === undefined ? undefined : [...pending.deps],
        cleanup: nextCleanup,
      } satisfies EffectState;
    }
  }

  private cleanupRemovedComponents(nextPaths: Set<string>): void {
    for (const componentPath of this.renderedComponentPaths) {
      if (!nextPaths.has(componentPath)) {
        this.cleanupComponentEffects(componentPath);
        this.hookState.delete(componentPath);
      }
    }
  }

  private cleanupRemovedErrorBoundaries(nextPaths: Set<string>): void {
    for (const boundaryPath of this.renderedErrorBoundaryPaths) {
      if (!nextPaths.has(boundaryPath)) {
        this.errorBoundaryState.delete(boundaryPath);
      }
    }
  }

  private cleanupAllEffects(): void {
    for (const componentPath of this.hookState.keys()) {
      this.cleanupComponentEffects(componentPath);
    }
  }

  private cleanupComponentEffects(componentPath: string): void {
    const hooks = this.hookState.get(componentPath);
    if (!hooks) {
      return;
    }

    for (const hook of hooks) {
      const effect = asEffectState(hook);
      if (effect?.phase === "layout") {
        effect.cleanup?.();
      }
    }

    for (const hook of hooks) {
      const effect = asEffectState(hook);
      if (effect?.phase === "passive") {
        effect.cleanup?.();
      }
    }
  }

  private patchChildren(parent: Element, nextNodes: Node[]): void {
    const oldNodes = Array.from(parent.childNodes);
    const usedOldNodes = new Set<Node>();
    const keyedOldNodes = new Map<string, Node>();

    for (const oldNode of oldNodes) {
      const key = this.nodeKeys.get(oldNode);
      if (key !== undefined) {
        keyedOldNodes.set(key, oldNode);
      }
    }

    let unkeyedIndex = 0;
    nextNodes.forEach((nextNode, index) => {
      const nextKey = this.nodeKeys.get(nextNode);
      let oldNode: Node | undefined;

      if (nextKey !== undefined) {
        const keyedOldNode = keyedOldNodes.get(nextKey);
        if (keyedOldNode && !usedOldNodes.has(keyedOldNode) && this.canPatchNode(keyedOldNode, nextNode)) {
          oldNode = keyedOldNode;
        }
      } else {
        while (
          unkeyedIndex < oldNodes.length &&
          (usedOldNodes.has(oldNodes[unkeyedIndex]) || this.nodeKeys.has(oldNodes[unkeyedIndex]))
        ) {
          unkeyedIndex += 1;
        }

        const candidate = oldNodes[unkeyedIndex];
        unkeyedIndex += 1;
        if (candidate && this.canPatchNode(candidate, nextNode)) {
          oldNode = candidate;
        }
      }

      const before = parent.childNodes[index] ?? null;
      if (oldNode) {
        usedOldNodes.add(oldNode);
        this.patchNode(oldNode, nextNode);
        if (oldNode !== before) {
          parent.insertBefore(oldNode, before);
        }
      } else {
        parent.insertBefore(nextNode, before);
      }
    });

    for (const oldNode of oldNodes) {
      if (!usedOldNodes.has(oldNode) && oldNode.parentNode === parent) {
        oldNode.remove();
      }
    }
  }

  private canPatchNode(oldNode: Node, nextNode: Node): boolean {
    if (oldNode.nodeType !== nextNode.nodeType) {
      return false;
    }

    if (oldNode.nodeType === 1 && nextNode.nodeType === 1) {
      return (oldNode as Element).localName === (nextNode as Element).localName;
    }

    return oldNode.nodeType === 3;
  }

  private patchNode(oldNode: Node, nextNode: Node): void {
    if (oldNode.nodeType === 3 && nextNode.nodeType === 3) {
      if (oldNode.nodeValue !== nextNode.nodeValue) {
        oldNode.nodeValue = nextNode.nodeValue;
      }
      this.copyNodeKey(oldNode, nextNode);
      return;
    }

    if (oldNode.nodeType === 1 && nextNode.nodeType === 1) {
      const oldElement = oldNode as Element;
      const nextElement = nextNode as Element;
      this.syncAttributes(oldElement, nextElement);
      this.syncEventHandlers(oldElement, nextElement);
      this.copyNodeKey(oldElement, nextElement);
      this.patchChildren(oldElement, Array.from(nextElement.childNodes));
      return;
    }

    oldNode.parentNode?.replaceChild(nextNode, oldNode);
  }

  private syncAttributes(target: Element, source: Element): void {
    for (const attribute of Array.from(target.attributes)) {
      if (!source.hasAttribute(attribute.name)) {
        target.removeAttribute(attribute.name);
      }
    }

    for (const attribute of Array.from(source.attributes)) {
      if (target.getAttribute(attribute.name) !== attribute.value) {
        target.setAttribute(attribute.name, attribute.value);
      }
    }
  }

  private setEventHandler(element: Element, eventName: string, listener: EventListener): void {
    let handlers = this.eventHandlers.get(element);
    if (!handlers) {
      handlers = new Map();
      this.eventHandlers.set(element, handlers);
    }

    const previous = handlers.get(eventName);
    if (previous) {
      element.removeEventListener(eventName, previous);
    }

    handlers.set(eventName, listener);
    element.addEventListener(eventName, listener);
  }

  private syncEventHandlers(target: Element, source: Element): void {
    const targetHandlers = this.eventHandlers.get(target) ?? new Map<string, EventListener>();
    const sourceHandlers = this.eventHandlers.get(source) ?? new Map<string, EventListener>();

    for (const [eventName, listener] of targetHandlers) {
      if (!sourceHandlers.has(eventName)) {
        target.removeEventListener(eventName, listener);
        targetHandlers.delete(eventName);
      }
    }

    for (const [eventName, listener] of sourceHandlers) {
      if (targetHandlers.get(eventName) !== listener) {
        const previous = targetHandlers.get(eventName);
        if (previous) {
          target.removeEventListener(eventName, previous);
        }
        target.addEventListener(eventName, listener);
        targetHandlers.set(eventName, listener);
      }
    }

    if (targetHandlers.size > 0) {
      this.eventHandlers.set(target, targetHandlers);
    } else {
      this.eventHandlers.delete(target);
    }
  }

  private setNodeKey(node: Node, key: string | number | null): void {
    if (key === null) {
      this.nodeKeys.delete(node);
    } else {
      this.nodeKeys.set(node, String(key));
    }
  }

  private copyNodeKey(target: Node, source: Node): void {
    const key = this.nodeKeys.get(source);
    if (key === undefined) {
      this.nodeKeys.delete(target);
    } else {
      this.nodeKeys.set(target, key);
    }
  }

  private resetErrorBoundary(boundaryPath: string): void {
    this.assertMounted();
    const state = this.errorBoundaryState.get(boundaryPath);
    if (!state || !("error" in state)) {
      return;
    }

    delete state.error;
    this.commitRender();
  }

  private componentPath(path: string, name: string, key: string | number | null): string {
    if (key === null) {
      return `${path}:${name}`;
    }

    const separatorIndex = path.lastIndexOf(".");
    const parentPath = separatorIndex === -1 ? path : path.slice(0, separatorIndex);
    return `${parentPath}:key:${name}:${String(key)}`;
  }

  private errorBoundaryPath(path: string, key: string | number | null): string {
    if (key === null) {
      return `${path}:ErrorBoundary`;
    }

    const separatorIndex = path.lastIndexOf(".");
    const parentPath = separatorIndex === -1 ? path : path.slice(0, separatorIndex);
    return `${parentPath}:key:ErrorBoundary:${String(key)}`;
  }
}

class HydrationCursor {
  private index = 0;
  private textOffset = 0;
  readonly label: string;
  private readonly nodes: Node[];

  constructor(nodes: Node[], label: string) {
    this.nodes = nodes;
    this.label = label;
  }

  next(expected: string): Node {
    if (this.textOffset !== 0) {
      throw new Error(`Ferrite hydration expected ${expected} at ${this.label}, found partially consumed text.`);
    }

    const node = this.nodes[this.index];
    if (!node) {
      throw new Error(`Ferrite hydration expected ${expected} at ${this.label}, found end of DOM.`);
    }

    this.index += 1;
    return node;
  }

  consumeText(expected: string): void {
    const node = this.nodes[this.index];
    if (!node) {
      throw new Error(`Ferrite hydration expected text at ${this.label}, found end of DOM.`);
    }

    if (node.nodeType !== 3) {
      throw new Error(`Ferrite hydration expected text at ${this.label}.`);
    }

    const value = node.nodeValue ?? "";
    const remaining = value.slice(this.textOffset);
    if (!remaining.startsWith(expected)) {
      throw new Error(`Ferrite hydration text mismatch at ${this.label}: expected "${expected}".`);
    }

    this.textOffset += expected.length;
    if (this.textOffset === value.length) {
      this.index += 1;
      this.textOffset = 0;
    }
  }

  assertDone(): void {
    if (this.textOffset !== 0) {
      throw new Error(`Ferrite hydration found extra text at ${this.label}.`);
    }

    if (this.index < this.nodes.length) {
      throw new Error(`Ferrite hydration found extra DOM nodes at ${this.label}.`);
    }
  }
}

function attributeNameFromProp(name: string): string {
  if (name === "className") {
    return "class";
  }

  if (name === "htmlFor") {
    return "for";
  }

  return name;
}

function shouldRunEffect(previous: EffectDependencyList | undefined, next: EffectDependencyList | undefined): boolean {
  return depsChanged(previous, next);
}

function depsChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) {
    return true;
  }

  if (previous.length !== next.length) {
    return true;
  }

  return next.some((value, index) => !Object.is(value, previous[index]));
}

function asEffectState(value: unknown): EffectState | undefined {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "effect") {
    return value as EffectState;
  }
  return undefined;
}

function asMemoState<T>(value: unknown): MemoState<T> | undefined {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "memo") {
    return value as MemoState<T>;
  }
  return undefined;
}

function asTransitionState(value: unknown): TransitionState | undefined {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "transition") {
    return value as TransitionState;
  }
  return undefined;
}

function asDeferredState<T>(value: unknown): DeferredState<T> | undefined {
  if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "deferred") {
    return value as DeferredState<T>;
  }
  return undefined;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}

function isRenderYield(error: unknown): error is RenderYield {
  return error instanceof RenderYield;
}

function cloneHookState(source: Map<string, HookState>): Map<string, HookState> {
  const clone = new Map<string, HookState>();
  for (const [path, hooks] of source) {
    clone.set(path, hooks.map(cloneHookValue));
  }
  return clone;
}

function cloneHookValue(value: unknown): unknown {
  const effect = asEffectState(value);
  if (effect) {
    return {
      ...effect,
      deps: effect.deps === undefined ? undefined : [...effect.deps],
    } satisfies EffectState;
  }

  const memo = asMemoState(value);
  if (memo) {
    return {
      ...memo,
      deps: memo.deps === undefined ? undefined : [...memo.deps],
    } satisfies MemoState;
  }

  const transition = asTransitionState(value);
  if (transition) {
    return { ...transition } satisfies TransitionState;
  }

  const deferred = asDeferredState(value);
  if (deferred) {
    return { ...deferred } satisfies DeferredState;
  }

  return value;
}

function cloneErrorBoundaryState(source: Map<string, ErrorBoundaryState>): Map<string, ErrorBoundaryState> {
  const clone = new Map<string, ErrorBoundaryState>();
  for (const [path, state] of source) {
    clone.set(path, { ...state });
  }
  return clone;
}

function eventNameFromProp(name: string): string | null {
  if (name.length <= 2 || !name.startsWith("on")) {
    return null;
  }

  const raw = name.slice(2);
  if (!/^[A-Z][A-Za-z]*$/.test(raw)) {
    return null;
  }

  return raw.toLowerCase();
}
