import {
  COMPACT_ELEMENT_OPCODE,
  COMPACT_FRAGMENT_OPCODE,
  COMPACT_TEXT_OPCODE,
  RENDER_PACKET_MARKER,
  RENDER_PACKET_VERSION,
} from "./protocol.js";
import type { CompactNode, RenderPacket, SerializableNode, SerializableProp } from "./protocol.js";

export {
  CLIENT_REFERENCE_MARKER,
  CLIENT_REFERENCE_VERSION,
  COMPACT_ELEMENT_OPCODE,
  COMPACT_FRAGMENT_OPCODE,
  COMPACT_TEXT_OPCODE,
  RENDER_PACKET_MARKER,
  RENDER_PACKET_VERSION,
  RENDER_STREAM_MARKER,
  SERVER_PAYLOAD_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_MARKER,
  SERVER_PAYLOAD_STREAM_FRAME_VERSION,
  SERVER_PAYLOAD_VERSION,
  createClientReferencePayload,
  parseClientReferenceId,
  validateClientReferenceParts,
  validateClientReferencePayload,
  validateServerPayloadPacket,
  validateServerPayloadStreamFrame,
} from "./protocol.js";
export type {
  ClientReferencePayload,
  ClientReferenceSerializableValue,
  CompactNode,
  RenderPacket,
  RenderStreamChunk,
  RenderStreamPacket,
  ServerPayloadChunk,
  ServerPayloadPacket,
  ServerPayloadStreamChunkFrame,
  ServerPayloadStreamFrame,
  ServerPayloadStreamShellFrame,
  SerializableNode,
  SerializableProp,
} from "./protocol.js";

export const Fragment = Symbol.for("ferrite.fragment");

const VNODE = Symbol.for("ferrite.vnode");

export type Key = string | number;
export type PrimitiveChild = string | number | boolean | null | undefined;
export type Child = PrimitiveChild | VNode | Child[] | Promise<Child>;
export type AsyncChild = Child | Promise<Child>;
export type Component<P = Record<string, never>> = (props: P & { children?: Child }) => AsyncChild;
export type ElementType<P = Record<string, unknown>> = string | Component<P> | typeof Fragment;

export type ErrorBoundaryFallbackProps = {
  error: unknown;
  reset: () => void;
};
export type ErrorBoundaryFallback = Child | ((props: ErrorBoundaryFallbackProps) => Child);
export type ErrorBoundaryProps = {
  fallback: ErrorBoundaryFallback;
  children?: Child;
};
export type SuspenseProps = {
  fallback: Child;
  children?: Child;
};

export interface VNode<P = Record<string, unknown>> {
  readonly $$typeof: typeof VNODE;
  readonly type: ElementType<P>;
  readonly key: Key | null;
  readonly props: P & { children?: Child };
}

export function createElement<P extends Record<string, unknown>>(
  type: ElementType<P>,
  props: (P & { key?: Key | null; children?: Child }) | null,
  ...children: Child[]
): VNode<P> {
  const inputProps = props ?? ({} as P & { key?: Key | null; children?: Child });
  const { key = null, children: propChildren, ...rest } = inputProps;
  const normalizedChildren = children.length === 0 ? propChildren : children.length === 1 ? children[0] : children;

  return {
    $$typeof: VNODE,
    type,
    key,
    props: {
      ...(rest as P),
      ...(normalizedChildren === undefined ? {} : { children: normalizedChildren }),
    },
  };
}

export function ErrorBoundary(props: ErrorBoundaryProps): VNode {
  return createElement(Fragment, null, props.children);
}

export function Suspense(props: SuspenseProps): VNode {
  return createElement(Fragment, null, props.children);
}

export function isVNode(value: unknown): value is VNode {
  return Boolean(value && typeof value === "object" && (value as { $$typeof?: symbol }).$$typeof === VNODE);
}

export function toSerializableNode(child: Child): SerializableNode | null {
  if (child === null || child === undefined || typeof child === "boolean") {
    return null;
  }

  if (isPromiseLike(child)) {
    throw new TypeError("Cannot serialize async Ferrite children with the synchronous serializer.");
  }

  if (typeof child === "string" || typeof child === "number") {
    return { kind: "text", value: String(child) };
  }

  if (Array.isArray(child)) {
    return {
      kind: "fragment",
      children: child.flatMap((item) => {
        const serialized = toSerializableNode(item);
        return serialized === null ? [] : [serialized];
      }),
    };
  }

  if (!isVNode(child)) {
    throw new TypeError("Cannot serialize non-VNode child.");
  }

  if (child.type === Fragment) {
    return toSerializableNode(child.props.children ?? []);
  }

  if (child.type === ErrorBoundary) {
    return toSerializableErrorBoundary(child.props as ErrorBoundaryProps);
  }

  if (child.type === Suspense) {
    return toSerializableNode((child.props as SuspenseProps).children);
  }

  if (typeof child.type === "function") {
    const rendered = child.type(child.props);
    if (isPromiseLike(rendered)) {
      throw new TypeError("Cannot serialize async Ferrite components with the synchronous serializer.");
    }
    return toSerializableNode(rendered);
  }

  if (typeof child.type !== "string") {
    throw new TypeError("Cannot serialize unsupported Ferrite element type.");
  }

  return {
    kind: "element",
    tag: child.type,
    props: serializeProps(child.props),
    children: flattenChildren(child.props.children),
  };
}

export function toRenderPacket(child: Child): RenderPacket {
  const serializable = toSerializableNode(child) ?? { kind: "fragment", children: [] };
  return serializableNodeToRenderPacket(serializable);
}

export function serializableNodeToRenderPacket(node: SerializableNode): RenderPacket {
  return {
    ferrite: RENDER_PACKET_MARKER,
    version: RENDER_PACKET_VERSION,
    root: toCompactNode(node),
  };
}

function toCompactNode(node: SerializableNode): CompactNode {
  if (node.kind === "text") {
    return [COMPACT_TEXT_OPCODE, node.value];
  }

  if (node.kind === "fragment") {
    return [COMPACT_FRAGMENT_OPCODE, node.children.map(toCompactNode)];
  }

  return [COMPACT_ELEMENT_OPCODE, node.tag, node.props, node.children.map(toCompactNode)];
}

function toSerializableErrorBoundary(props: ErrorBoundaryProps): SerializableNode | null {
  if (!("fallback" in props)) {
    throw new TypeError("Ferrite ErrorBoundary requires a fallback prop.");
  }

  try {
    return toSerializableNode(props.children);
  } catch (error) {
    return toSerializableNode(renderErrorBoundaryFallback(props.fallback, error, () => undefined));
  }
}

export function renderErrorBoundaryFallback(
  fallback: ErrorBoundaryFallback,
  error: unknown,
  reset: () => void,
): Child {
  if (typeof fallback === "function") {
    return fallback({ error, reset });
  }

  return fallback;
}

function flattenChildren(child: Child): SerializableNode[] {
  const serialized = toSerializableNode(child);
  if (serialized === null) {
    return [];
  }
  if (serialized.kind === "fragment") {
    return serialized.children;
  }
  return [serialized];
}

function serializeProps(props: Record<string, unknown>): Record<string, SerializableProp> {
  const serialized: Record<string, SerializableProp> = {};

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key.startsWith("on")) {
      continue;
    }

    if (value === null || value === undefined || value === false) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      serialized[serializablePropName(key)] = value;
      continue;
    }

    throw new TypeError(`Cannot serialize prop "${key}" with type "${typeof value}".`);
  }

  return serialized;
}

function serializablePropName(name: string): string {
  if (name === "className") {
    return "class";
  }

  if (name === "htmlFor") {
    return "for";
  }

  return name;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}

export type StateUpdater<S> = (next: S | ((previous: S) => S)) => void;
export type EffectCleanup = void | (() => void);
export type EffectCallback = () => EffectCleanup;
export type EffectDependencyList = readonly unknown[];
export type MemoDependencyList = readonly unknown[];
export type TransitionScope = () => void;
export type TransitionStartFunction = (scope: TransitionScope) => void;
export type SchedulerPriority = "sync" | "transition";
export type SchedulerCallback = () => void;

export interface RefObject<T> {
  current: T;
}

export interface HookDispatcher {
  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>];
  useEffect(effect: EffectCallback, deps?: EffectDependencyList): void;
  useLayoutEffect(effect: EffectCallback, deps?: EffectDependencyList): void;
  useRef<T>(initial: T): RefObject<T>;
  useMemo<T>(factory: () => T, deps?: MemoDependencyList): T;
  useTransition(): [boolean, TransitionStartFunction];
  useDeferredValue<T>(value: T): T;
}

let currentDispatcher: HookDispatcher | null = null;
let transitionScopeDepth = 0;
let nextSchedulerTaskId = 1;
let schedulerHostCallbackScheduled = false;
let schedulerRenderPriority: SchedulerPriority = "sync";
let schedulerRenderDeadline = 0;
let schedulerYieldIntervalMs = 5;
let schedulerForcedRenderBudget: number | null = null;
const scheduledTasks: ScheduledTask[] = [];

type ScheduledTask = {
  id: number;
  priority: SchedulerPriority;
  callback: SchedulerCallback;
  cancelled: boolean;
};

export function withHookDispatcher<T>(dispatcher: HookDispatcher, render: () => T): T {
  const previousDispatcher = currentDispatcher;
  currentDispatcher = dispatcher;
  try {
    return render();
  } finally {
    currentDispatcher = previousDispatcher;
  }
}

export function useState<S>(initial: S | (() => S)): [S, StateUpdater<S>] {
  if (!currentDispatcher) {
    throw new Error("Ferrite useState can only be called while rendering a component.");
  }

  return currentDispatcher.useState(initial);
}

export function useEffect(effect: EffectCallback, deps?: EffectDependencyList): void {
  if (!currentDispatcher) {
    throw new Error("Ferrite useEffect can only be called while rendering a component.");
  }

  currentDispatcher.useEffect(effect, deps);
}

export function useLayoutEffect(effect: EffectCallback, deps?: EffectDependencyList): void {
  if (!currentDispatcher) {
    throw new Error("Ferrite useLayoutEffect can only be called while rendering a component.");
  }

  currentDispatcher.useLayoutEffect(effect, deps);
}

export function useRef<T>(initial: T): RefObject<T> {
  if (!currentDispatcher) {
    throw new Error("Ferrite useRef can only be called while rendering a component.");
  }

  return currentDispatcher.useRef(initial);
}

export function useMemo<T>(factory: () => T, deps?: MemoDependencyList): T {
  if (!currentDispatcher) {
    throw new Error("Ferrite useMemo can only be called while rendering a component.");
  }

  return currentDispatcher.useMemo(factory, deps);
}

export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps?: MemoDependencyList): T {
  return useMemo(() => callback, deps);
}

export function startTransition(scope: TransitionScope): void {
  if (typeof scope !== "function") {
    throw new TypeError("Ferrite startTransition requires a function.");
  }

  transitionScopeDepth += 1;
  try {
    scope();
  } finally {
    transitionScopeDepth -= 1;
  }
}

export function useTransition(): [boolean, TransitionStartFunction] {
  if (!currentDispatcher) {
    throw new Error("Ferrite useTransition can only be called while rendering a component.");
  }

  return currentDispatcher.useTransition();
}

export function useDeferredValue<T>(value: T): T {
  if (!currentDispatcher) {
    throw new Error("Ferrite useDeferredValue can only be called while rendering a component.");
  }

  return currentDispatcher.useDeferredValue(value);
}

export function __isTransitionScopeActive(): boolean {
  return transitionScopeDepth > 0;
}

export function unstable_scheduleCallback(priority: SchedulerPriority, callback: SchedulerCallback): () => void {
  assertSchedulerPriority(priority);
  if (typeof callback !== "function") {
    throw new TypeError("Ferrite scheduler callback must be a function.");
  }

  if (priority === "sync") {
    callback();
    return () => undefined;
  }

  const task: ScheduledTask = {
    id: nextSchedulerTaskId,
    priority,
    callback,
    cancelled: false,
  };
  nextSchedulerTaskId += 1;
  scheduledTasks.push(task);
  scheduledTasks.sort(compareScheduledTasks);
  requestSchedulerHostCallback();

  return () => {
    task.cancelled = true;
  };
}

export function unstable_shouldYield(): boolean {
  if (schedulerRenderPriority !== "transition") {
    return false;
  }

  if (schedulerForcedRenderBudget !== null) {
    schedulerForcedRenderBudget -= 1;
    return schedulerForcedRenderBudget < 0;
  }

  return schedulerRenderDeadline !== 0 && schedulerNow() >= schedulerRenderDeadline;
}

export function unstable_setSchedulerRenderBudget(units: number | null): void {
  if (units === null) {
    schedulerForcedRenderBudget = null;
    return;
  }

  if (!Number.isInteger(units)) {
    throw new TypeError("Ferrite scheduler render budget must be an integer or null.");
  }

  if (units < 0) {
    throw new RangeError("Ferrite scheduler render budget must be non-negative.");
  }

  schedulerForcedRenderBudget = units;
}

export function unstable_setSchedulerYieldInterval(ms: number): void {
  if (!Number.isFinite(ms)) {
    throw new TypeError("Ferrite scheduler yield interval must be a finite number.");
  }

  if (ms < 0) {
    throw new RangeError("Ferrite scheduler yield interval must be non-negative.");
  }

  schedulerYieldIntervalMs = ms;
}

export function __withSchedulerRender<T>(priority: SchedulerPriority, render: () => T): T {
  assertSchedulerPriority(priority);
  const previousPriority = schedulerRenderPriority;
  const previousDeadline = schedulerRenderDeadline;
  schedulerRenderPriority = priority;
  schedulerRenderDeadline = priority === "transition" ? schedulerNow() + schedulerYieldIntervalMs : 0;
  try {
    return render();
  } finally {
    schedulerRenderPriority = previousPriority;
    schedulerRenderDeadline = previousDeadline;
  }
}

function compareScheduledTasks(left: ScheduledTask, right: ScheduledTask): number {
  const priorityDelta = schedulerPriorityRank(left.priority) - schedulerPriorityRank(right.priority);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.id - right.id;
}

function schedulerPriorityRank(priority: SchedulerPriority): number {
  return priority === "sync" ? 0 : 1;
}

function requestSchedulerHostCallback(): void {
  if (schedulerHostCallbackScheduled) {
    return;
  }

  schedulerHostCallbackScheduled = true;
  setTimeout(flushScheduledTasks, 0);
}

function flushScheduledTasks(): void {
  schedulerHostCallbackScheduled = false;

  while (scheduledTasks.length > 0) {
    const task = scheduledTasks.shift();
    if (!task || task.cancelled) {
      continue;
    }

    task.callback();
    break;
  }

  if (scheduledTasks.some((task) => !task.cancelled)) {
    requestSchedulerHostCallback();
  }
}

function schedulerNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function assertSchedulerPriority(priority: SchedulerPriority): void {
  if (priority !== "sync" && priority !== "transition") {
    throw new TypeError(`Ferrite scheduler priority "${String(priority)}" is not supported.`);
  }
}
