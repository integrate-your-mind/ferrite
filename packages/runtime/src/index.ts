export * from "./index-base.js";

import {
  ErrorBoundary,
  Fragment,
  Suspense,
  isVNode,
  serializableNodeToRenderPacket,
  toSerializableNode as baseToSerializableNode,
  type Child,
  type Component,
  type ErrorBoundaryFallback,
  type ErrorBoundaryProps,
  type RenderPacket,
  type SerializableNode,
  type SuspenseProps,
  type VNode,
} from "./index-base.js";

const componentWrappers = new WeakMap<Component<Record<string, unknown>>, Component<Record<string, unknown>>>();
const htmlBooleanAttributes = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "capture",
  "checked",
  "controls",
  "credentialless",
  "default",
  "defer",
  "disabled",
  "disablepictureinpicture",
  "disableremoteplayback",
  "download",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "scoped",
  "seamless",
  "selected",
]);

export function toSerializableNode(child: Child): SerializableNode | null {
  return baseToSerializableNode(__normalizeAttributeChild(child));
}

export function toRenderPacket(child: Child): RenderPacket {
  const serializable = toSerializableNode(child) ?? { kind: "fragment", children: [] };
  return serializableNodeToRenderPacket(serializable);
}

export function __normalizeAttributeChild(child: Child): Child {
  if (child === null || child === undefined || typeof child === "boolean") {
    return child;
  }
  if (typeof child === "string" || typeof child === "number") {
    return child;
  }
  if (isPromiseLike(child)) {
    return child.then(__normalizeAttributeChild);
  }
  if (Array.isArray(child)) {
    return child.map(__normalizeAttributeChild);
  }
  if (!isVNode(child)) {
    return child;
  }
  return normalizeVNode(child);
}

function normalizeVNode(vnode: VNode): VNode {
  if (typeof vnode.type === "string") {
    return cloneVNode(vnode, vnode.type, normalizeElementProps(vnode.type, vnode.props));
  }
  if (vnode.type === Fragment) {
    return cloneVNode(vnode, Fragment, normalizeChildrenOnly(vnode.props));
  }
  if (vnode.type === Suspense) {
    const props = vnode.props as SuspenseProps;
    return cloneVNode(vnode, Suspense, {
      ...props,
      fallback: __normalizeAttributeChild(props.fallback),
      children: __normalizeAttributeChild(props.children),
    });
  }
  if (vnode.type === ErrorBoundary) {
    const props = vnode.props as ErrorBoundaryProps;
    return cloneVNode(vnode, ErrorBoundary, {
      ...props,
      fallback: normalizeErrorBoundaryFallback(props.fallback),
      children: __normalizeAttributeChild(props.children),
    });
  }
  if (typeof vnode.type === "function") {
    const component = vnode.type as Component<Record<string, unknown>>;
    return cloneVNode(vnode, normalizedComponent(component), normalizeChildrenOnly(vnode.props));
  }
  return vnode;
}

function normalizedComponent(component: Component<Record<string, unknown>>): Component<Record<string, unknown>> {
  const existing = componentWrappers.get(component);
  if (existing) {
    return existing;
  }
  const wrapped: Component<Record<string, unknown>> = (props) => {
    const rendered = component(props);
    return isPromiseLike(rendered)
      ? rendered.then(__normalizeAttributeChild)
      : __normalizeAttributeChild(rendered);
  };
  Object.defineProperty(wrapped, "name", {
    configurable: true,
    value: component.name || "Component",
  });
  componentWrappers.set(component, wrapped);
  return wrapped;
}

function normalizeErrorBoundaryFallback(fallback: ErrorBoundaryFallback): ErrorBoundaryFallback {
  if (typeof fallback !== "function") {
    return __normalizeAttributeChild(fallback);
  }
  return (props) => __normalizeAttributeChild(fallback(props));
}

function normalizeChildrenOnly(props: Record<string, unknown>): Record<string, unknown> {
  if (!("children" in props)) {
    return props;
  }
  return {
    ...props,
    children: __normalizeAttributeChild(props.children as Child),
  };
}

function normalizeElementProps(tag: string, props: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props)) {
    if (name === "children") {
      normalized.children = __normalizeAttributeChild(value as Child);
      continue;
    }
    if (typeof value === "boolean" && !isHtmlBooleanProp(tag, name)) {
      normalized[name] = String(value);
      continue;
    }
    normalized[name] = value;
  }
  return normalized;
}

function isHtmlBooleanProp(tag: string, name: string): boolean {
  const attribute = serializableAttributeName(tag, name).toLowerCase();
  return htmlBooleanAttributes.has(attribute);
}

function serializableAttributeName(tag: string, name: string): string {
  if (name === "className") {
    return "class";
  }
  if (name === "htmlFor") {
    return "for";
  }
  if (tag.toLowerCase() === "input" && name === "defaultValue") {
    return "value";
  }
  if (tag.toLowerCase() === "input" && name === "defaultChecked") {
    return "checked";
  }
  return name;
}

function cloneVNode(vnode: VNode, type: unknown, props: Record<string, unknown>): VNode {
  return {
    ...vnode,
    type,
    props,
  } as VNode;
}

function isPromiseLike(value: unknown): value is Promise<Child> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}
