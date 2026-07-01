import {
  ErrorBoundary,
  Fragment,
  Suspense,
  createElement,
  isVNode,
  renderErrorBoundaryFallback,
  serializableNodeToRenderPacket,
  withHookDispatcher,
  type Child,
  type CompactNode,
  type Component,
  type EffectCallback,
  type EffectDependencyList,
  type MemoDependencyList,
  type RefObject,
  type RenderPacket,
  type RenderStreamPacket,
  type ErrorBoundaryProps,
  type SerializableNode,
  type StateUpdater,
  type SuspenseProps,
  type TransitionStartFunction,
} from "./index.js";
import { createClientReferencePayload, parseClientReferenceId } from "./protocol.js";
import type { ClientReferenceSerializableValue } from "./protocol.js";

export type PageModule<Props extends Record<string, unknown> = Record<string, unknown>> = {
  default: (props: Props) => Child | Promise<Child>;
  generateStaticParams?: () => unknown[] | Promise<unknown[]>;
  metadata?: unknown;
  generateMetadata?: (props: Props) => unknown | Promise<unknown>;
};

export type LayoutModule = {
  default: (props: { children: Child }) => Child | Promise<Child>;
  metadata?: unknown;
  generateMetadata?: (props: Record<string, unknown>) => unknown | Promise<unknown>;
};

export type DocumentModule = {
  default: (props: DocumentProps) => Child | Promise<Child>;
};

export type LoadingModule<Props extends Record<string, unknown> = Record<string, unknown>> = {
  default: (props: Props) => Child | Promise<Child>;
};

export type ErrorModule = {
  default: (props: ErrorFileProps) => Child | Promise<Child>;
};

export type ErrorFileProps = {
  error: unknown;
};

export type RouteConventionModules = {
  loading?: LoadingModule;
  error?: ErrorModule;
};

export type Metadata = {
  title?: string;
  description?: string;
  openGraph?: OpenGraphMetadata;
  icons?: IconMetadata[];
  alternates?: AlternateMetadata;
};

export type OpenGraphMetadata = {
  title?: string;
  description?: string;
  url?: string;
  siteName?: string;
  type?: string;
  images?: OpenGraphImage[];
};

export type OpenGraphImage = {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type IconMetadata = {
  url: string;
  rel?: string;
  type?: string;
  sizes?: string;
};

export type AlternateMetadata = {
  canonical?: string;
  languages?: Record<string, string>;
};

export type DocumentProps = {
  children: Child;
  head: Child;
  routePath: string;
  routePattern?: string;
  buildId?: number;
  metadata: Metadata;
};

export type DocumentRenderOptions = {
  rootId: string;
  routePath: string;
  routePattern?: string;
  buildId?: number;
  metadata?: Metadata;
  styles?: string[];
  scripts?: string[];
  defaultTitle?: string;
};

export type ClientReferenceSerializedProps = Record<string, ClientReferenceSerializableValue>;

export type ClientReferenceOptions<Props extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  render: Component<Props>;
};

export type StaticParamsResult = {
  has_generate_static_params: boolean;
  params: Array<Record<string, string | string[]>>;
};

type ServerRenderContext = {
  stream: boolean;
  nextSuspenseId: number;
  chunks: PendingStreamChunk[];
};

type PendingStreamChunk = {
  id: string;
  promise: Promise<SerializableNode>;
};

type MaybePromise<T> = T | Promise<T>;

export function createClientReference<Props extends Record<string, unknown> = Record<string, unknown>>(
  options: ClientReferenceOptions<Props>,
): Component<Props> {
  if (!options || typeof options.id !== "string" || options.id.length === 0) {
    throw new TypeError("Ferrite client reference requires a non-empty id.");
  }

  if (typeof options.render !== "function") {
    throw new TypeError("Ferrite client reference requires a render component function.");
  }

  parseClientReferenceId(options.id);

  return function FerriteClientReference(props) {
    const serializedProps = serializeClientReferenceProps(props);
    const payload = createClientReferencePayload({ id: options.id, props: serializedProps });
    return createServerElement(
      "span",
      {
        "data-ferrite-client-reference": options.id,
        "data-ferrite-client-props": JSON.stringify(serializedProps),
        "data-ferrite-client-payload": JSON.stringify(payload),
      },
      createElement(options.render, props) as Child,
    );
  };
}

export async function renderPageModule(
  module: PageModule,
  props: Record<string, unknown> = {},
  layouts: LayoutModule[] = [],
  conventions: RouteConventionModules = {},
): Promise<SerializableNode> {
  const rendered = await renderPageChild(module, props, layouts, conventions);
  return (await renderServerChildFinal(rendered)) ?? emptyFragment();
}

export async function renderPageModuleToPacket(
  module: PageModule,
  props: Record<string, unknown> = {},
  layouts: LayoutModule[] = [],
  conventions: RouteConventionModules = {},
): Promise<RenderPacket> {
  return serializableNodeToRenderPacket(await renderPageModule(module, props, layouts, conventions));
}

export async function renderPageModuleToStreamPacket(
  module: PageModule,
  props: Record<string, unknown> = {},
  layouts: LayoutModule[] = [],
  conventions: RouteConventionModules = {},
): Promise<RenderStreamPacket> {
  const rendered = await renderPageChild(module, props, layouts, conventions, { stream: true });
  return renderServerChildToStreamPacket(rendered);
}

export async function renderDocumentModule(
  pageModule: PageModule,
  props: Record<string, unknown>,
  layouts: LayoutModule[],
  documentModule: DocumentModule,
  options: DocumentRenderOptions,
  conventions: RouteConventionModules = {},
): Promise<SerializableNode> {
  if (typeof documentModule.default !== "function") {
    throw new TypeError("Ferrite document module must export a default component function.");
  }

  const page = await renderPageChild(pageModule, props, layouts, conventions);
  const metadata = normalizeMetadata(options.metadata, "document options");
  const rootProps: Record<string, unknown> = {
    id: options.rootId,
    "data-route": options.routePath,
  };
  if (options.routePattern) {
    rootProps["data-route-pattern"] = options.routePattern;
  }
  if (options.buildId !== undefined) {
    rootProps["data-ferrite-build-id"] = options.buildId;
  }

  const children = createServerElement("div", rootProps, page);
  const head = createDocumentHead(metadata, options);
  const rendered = await withHookDispatcher(serverHookDispatcher, () =>
    documentModule.default({
      children,
      head,
      routePath: options.routePath,
      routePattern: options.routePattern,
      buildId: options.buildId,
      metadata,
    }),
  );
  const serializable = await renderServerChildFinal(rendered);
  if (!serializable || serializable.kind !== "element" || serializable.tag !== "html") {
    throw new TypeError("Ferrite document module must render an <html> element.");
  }

  return serializable;
}

export async function renderDocumentModuleToPacket(
  pageModule: PageModule,
  props: Record<string, unknown>,
  layouts: LayoutModule[],
  documentModule: DocumentModule,
  options: DocumentRenderOptions,
  conventions: RouteConventionModules = {},
): Promise<RenderPacket> {
  return serializableNodeToRenderPacket(
    await renderDocumentModule(pageModule, props, layouts, documentModule, options, conventions),
  );
}

export async function renderDocumentModuleToStreamPacket(
  pageModule: PageModule,
  props: Record<string, unknown>,
  layouts: LayoutModule[],
  documentModule: DocumentModule,
  options: DocumentRenderOptions,
  conventions: RouteConventionModules = {},
): Promise<RenderStreamPacket> {
  if (typeof documentModule.default !== "function") {
    throw new TypeError("Ferrite document module must export a default component function.");
  }

  const page = await renderPageChild(pageModule, props, layouts, conventions, { stream: true });
  const context = createServerRenderContext(true);
  const metadata = normalizeMetadata(options.metadata, "document options");
  const rootProps: Record<string, unknown> = {
    id: options.rootId,
    "data-route": options.routePath,
  };
  if (options.routePattern) {
    rootProps["data-route-pattern"] = options.routePattern;
  }
  if (options.buildId !== undefined) {
    rootProps["data-ferrite-build-id"] = options.buildId;
  }

  const children = createServerElement("div", rootProps, page);
  const head = createDocumentHead(metadata, options);
  const rendered = await withHookDispatcher(serverHookDispatcher, () =>
    documentModule.default({
      children,
      head,
      routePath: options.routePath,
      routePattern: options.routePattern,
      buildId: options.buildId,
      metadata,
    }),
  );
  const documentShell = await resolveRenderedNode(renderServerChildMaybe(rendered, context));
  if (!documentShell || documentShell.kind !== "element" || documentShell.tag !== "html") {
    throw new TypeError("Ferrite document module must render an <html> element.");
  }

  return renderStreamPacketFromShell(documentShell, context);
}

export async function collectStaticParams(module: PageModule): Promise<StaticParamsResult> {
  if (module.generateStaticParams === undefined) {
    return { has_generate_static_params: false, params: [] };
  }

  if (typeof module.generateStaticParams !== "function") {
    throw new TypeError("Ferrite generateStaticParams export must be a function.");
  }

  const result = await module.generateStaticParams();
  if (!Array.isArray(result)) {
    throw new TypeError("Ferrite generateStaticParams must return an array.");
  }

  return {
    has_generate_static_params: true,
    params: result.map((entry, index) => normalizeStaticParamsEntry(entry, index)),
  };
}

export async function collectPageMetadata(
  module: PageModule,
  props: Record<string, unknown> = {},
  layouts: LayoutModule[] = [],
): Promise<Metadata> {
  const metadata: Metadata = {};

  for (const [index, layout] of layouts.entries()) {
    mergeMetadata(metadata, await metadataFromModule(layout, props, `layout module ${index}`));
  }

  mergeMetadata(metadata, await metadataFromModule(module, props, "page module"));
  return metadata;
}

async function renderPageChild(
  module: PageModule,
  props: Record<string, unknown>,
  layouts: LayoutModule[],
  conventions: RouteConventionModules = {},
  options: { stream?: boolean } = {},
): Promise<Child> {
  if (typeof module.default !== "function") {
    throw new TypeError("Ferrite page module must export a default component function.");
  }

  if (conventions.loading !== undefined && typeof conventions.loading.default !== "function") {
    throw new TypeError("Ferrite loading module must export a default component function.");
  }

  if (conventions.error !== undefined && typeof conventions.error.default !== "function") {
    throw new TypeError("Ferrite error module must export a default component function.");
  }

  for (const [index, layout] of layouts.entries()) {
    if (typeof layout.default !== "function") {
      throw new TypeError(`Ferrite layout module ${index} must export a default component function.`);
    }
  }

  let rendered: Child;
  try {
    rendered = withHookDispatcher(serverHookDispatcher, () => module.default(props));
  } catch (error) {
    rendered = renderErrorModule(conventions.error, error);
  }

  const errorModule = conventions.error;
  if (errorModule) {
    rendered = createElement(
      ErrorBoundary,
      {
        fallback: ({ error }) => renderErrorModule(errorModule, error),
      },
      rendered,
    ) as unknown as Child;
  }

  const loadingModule = conventions.loading;
  if (options.stream && loadingModule) {
    rendered = createElement(
      Suspense,
      {
        fallback: renderLoadingModule(loadingModule, props),
      },
      rendered,
    ) as unknown as Child;
  }

  for (const layout of [...layouts].reverse()) {
    rendered = withHookDispatcher(serverHookDispatcher, () => layout.default({ children: rendered }));
  }

  return rendered;
}

function renderLoadingModule(module: LoadingModule, props: Record<string, unknown>): Child {
  return withHookDispatcher(serverHookDispatcher, () => module.default(props));
}

function renderErrorModule(module: ErrorModule | undefined, error: unknown): Child {
  if (!module) {
    throw error;
  }

  return withHookDispatcher(serverHookDispatcher, () => module.default({ error }));
}

function createDocumentHead(metadata: Metadata, options: DocumentRenderOptions): Child {
  const title = metadata.title ?? options.defaultTitle ?? "Ferrite";
  const children: Child[] = [
    createServerElement("meta", { charset: "utf-8" }),
    createServerElement("title", null, title),
  ];

  if (metadata.description) {
    children.push(createServerElement("meta", { name: "description", content: metadata.description }));
  }

  children.push(...createOpenGraphHead(metadata.openGraph));
  children.push(...createIconHead(metadata.icons));
  children.push(...createAlternateHead(metadata.alternates));

  for (const href of options.styles ?? []) {
    children.push(createServerElement("link", { rel: "stylesheet", href }));
  }

  for (const src of options.scripts ?? []) {
    children.push(createServerElement("script", { type: "module", src }));
  }

  return createElement(Fragment, null, children) as Child;
}

function createServerElement(type: string, props: Record<string, unknown> | null, ...children: Child[]): Child {
  return createElement(type, props, ...children) as Child;
}

async function renderServerChildFinal(child: Child): Promise<SerializableNode | null> {
  const context = createServerRenderContext(false);
  return resolveRenderedNode(renderServerChildMaybe(child, context));
}

async function renderServerChildToStreamPacket(child: Child): Promise<RenderStreamPacket> {
  const context = createServerRenderContext(true);
  const shell = (await resolveRenderedNode(renderServerChildMaybe(child, context))) ?? emptyFragment();
  return renderStreamPacketFromShell(shell, context);
}

async function renderStreamPacketFromShell(
  shell: SerializableNode,
  context: ServerRenderContext,
): Promise<RenderStreamPacket> {
  const chunks: RenderStreamPacket["chunks"] = [];
  for (let index = 0; index < context.chunks.length; index += 1) {
    const chunk = context.chunks[index];
    chunks.push({
      id: chunk.id,
      root: toCompactRoot(await chunk.promise),
    });
  }

  return {
    ferrite: "render-stream",
    version: 1,
    shell: toCompactRoot(shell),
    chunks,
  };
}

function createServerRenderContext(stream: boolean): ServerRenderContext {
  return {
    stream,
    nextSuspenseId: 0,
    chunks: [],
  };
}

function renderServerChildMaybe(
  child: Child,
  context: ServerRenderContext,
): MaybePromise<SerializableNode | null> {
  if (child === null || child === undefined || typeof child === "boolean") {
    return null;
  }

  if (isPromiseLike(child)) {
    return child.then((value) => resolveRenderedNode(renderServerChildMaybe(value, context)));
  }

  if (typeof child === "string" || typeof child === "number") {
    return { kind: "text", value: String(child) };
  }

  if (Array.isArray(child)) {
    const children = child.map((item) => renderServerChildMaybe(item, context));
    if (children.some(isPromiseLike)) {
      return Promise.all(children.map(resolveRenderedNode)).then((nodes) => ({
        kind: "fragment",
        children: nodes.flatMap(flattenSerializableNode),
      }));
    }

    return {
      kind: "fragment",
      children: children.flatMap((node) => flattenSerializableNode(node as SerializableNode | null)),
    };
  }

  if (!isVNode(child)) {
    throw new TypeError("Cannot serialize non-VNode child.");
  }

  if (child.type === Fragment) {
    return renderServerChildMaybe(child.props.children ?? [], context);
  }

  if (child.type === Suspense) {
    return renderServerSuspenseMaybe(child.props as SuspenseProps, context);
  }

  if (child.type === ErrorBoundary) {
    return renderServerErrorBoundaryMaybe(child.props as ErrorBoundaryProps, context);
  }

  if (typeof child.type === "function") {
    const component = child.type;
    const rendered = withHookDispatcher(serverHookDispatcher, () => component(child.props));
    if (isPromiseLike(rendered)) {
      return rendered.then((value) => resolveRenderedNode(renderServerChildMaybe(value, context)));
    }
    return renderServerChildMaybe(rendered, context);
  }

  if (typeof child.type !== "string") {
    throw new TypeError("Cannot serialize unsupported Ferrite element type.");
  }

  const children = renderServerChildrenMaybe(child.props.children, context);
  if (isPromiseLike(children)) {
    return children.then((resolvedChildren) => ({
      kind: "element",
      tag: child.type as string,
      props: serializeServerProps(child.props),
      children: resolvedChildren,
    }));
  }

  return {
    kind: "element",
    tag: child.type,
    props: serializeServerProps(child.props),
    children,
  };
}

function renderServerErrorBoundaryMaybe(
  props: ErrorBoundaryProps,
  context: ServerRenderContext,
): MaybePromise<SerializableNode | null> {
  if (!("fallback" in props)) {
    throw new TypeError("Ferrite ErrorBoundary requires a fallback prop.");
  }

  try {
    const rendered = renderServerChildMaybe(props.children, context);
    if (isPromiseLike(rendered)) {
      return rendered.catch((error) =>
        resolveRenderedNode(
          renderServerChildMaybe(renderErrorBoundaryFallback(props.fallback, error, () => undefined), context),
        ),
      );
    }
    return rendered;
  } catch (error) {
    return renderServerChildMaybe(renderErrorBoundaryFallback(props.fallback, error, () => undefined), context);
  }
}

function renderServerSuspenseMaybe(
  props: SuspenseProps,
  context: ServerRenderContext,
): MaybePromise<SerializableNode | null> {
  if (!("fallback" in props)) {
    throw new TypeError("Ferrite Suspense requires a fallback prop.");
  }

  const rendered = renderServerChildMaybe(props.children, context);
  if (!context.stream || !isPromiseLike(rendered)) {
    return rendered;
  }

  const fallbackContext = createServerRenderContext(false);
  const fallback = renderServerChildMaybe(props.fallback, fallbackContext);
  if (isPromiseLike(fallback)) {
    throw new TypeError("Ferrite Suspense fallback must render synchronously for streaming.");
  }

  const id = `s${context.nextSuspenseId}`;
  context.nextSuspenseId += 1;
  context.chunks.push({
    id,
    promise: rendered.then((node) => node ?? emptyFragment()),
  });

  return {
    kind: "element",
    tag: "div",
    props: { "data-ferrite-suspense-boundary": id },
    children: flattenSerializableNode(fallback),
  };
}

function renderServerChildrenMaybe(
  child: Child,
  context: ServerRenderContext,
): MaybePromise<SerializableNode[]> {
  const rendered = renderServerChildMaybe(child, context);
  if (isPromiseLike(rendered)) {
    return rendered.then(flattenSerializableNode);
  }
  return flattenSerializableNode(rendered);
}

async function resolveRenderedNode(
  rendered: MaybePromise<SerializableNode | null>,
): Promise<SerializableNode | null> {
  return rendered;
}

function flattenSerializableNode(node: SerializableNode | null): SerializableNode[] {
  if (!node) {
    return [];
  }
  if (node.kind === "fragment") {
    return node.children;
  }
  return [node];
}

function emptyFragment(): SerializableNode {
  return { kind: "fragment", children: [] };
}

function toCompactRoot(node: SerializableNode): CompactNode {
  return serializableNodeToRenderPacket(node).root;
}

function serializeServerProps(props: Record<string, unknown>): Record<string, string | number | boolean> {
  const serialized: Record<string, string | number | boolean> = {};

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

function serializeClientReferenceProps(props: Record<string, unknown>): ClientReferenceSerializedProps {
  const serialized: ClientReferenceSerializedProps = {};

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key") {
      continue;
    }

    serialized[key] = serializeClientReferenceValue(value, `prop "${key}"`);
  }

  return serialized;
}

function serializeClientReferenceValue(value: unknown, path: string): ClientReferenceSerializableValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    throw new TypeError(`Ferrite client reference ${path} must be JSON-serializable.`);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => serializeClientReferenceValue(item, `${path}[${index}]`));
  }

  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Ferrite client reference ${path} must be JSON-serializable.`);
    }

    const serialized: { [key: string]: ClientReferenceSerializableValue } = {};
    for (const [key, childValue] of Object.entries(value)) {
      serialized[key] = serializeClientReferenceValue(childValue, `${path}.${key}`);
    }
    return serialized;
  }

  throw new TypeError(`Ferrite client reference ${path} must be JSON-serializable.`);
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}

function normalizeStaticParamsEntry(entry: unknown, index: number): Record<string, string | string[]> {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`Ferrite generateStaticParams entry ${index} must be an object.`);
  }

  const params: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) {
      continue;
    }

    if (typeof value === "string") {
      params[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      params[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      throw new TypeError(
        `Ferrite generateStaticParams entry ${index} property "${key}" array values must be strings.`,
      );
    }

    throw new TypeError(
      `Ferrite generateStaticParams entry ${index} property "${key}" must be a string or string array.`,
    );
  }
  return params;
}

async function metadataFromModule(
  module: PageModule | LayoutModule,
  props: Record<string, unknown>,
  label: string,
): Promise<Metadata> {
  if (module.generateMetadata !== undefined && typeof module.generateMetadata !== "function") {
    throw new TypeError(`Ferrite ${label} generateMetadata export must be a function.`);
  }

  if (module.generateMetadata) {
    return normalizeMetadata(await module.generateMetadata(props), label);
  }

  return normalizeMetadata(module.metadata, label);
}

function normalizeMetadata(value: unknown, label: string): Metadata {
  if (value === undefined) {
    return {};
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Ferrite ${label} metadata must be an object.`);
  }

  const input = value as Record<string, unknown>;
  const metadata: Metadata = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string") {
      throw new TypeError(`Ferrite ${label} metadata.title must be a string.`);
    }
    metadata.title = input.title;
  }

  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      throw new TypeError(`Ferrite ${label} metadata.description must be a string.`);
    }
    metadata.description = input.description;
  }

  if (input.openGraph !== undefined) {
    metadata.openGraph = normalizeOpenGraphMetadata(input.openGraph, label);
  }

  if (input.icons !== undefined) {
    metadata.icons = normalizeIconMetadata(input.icons, label);
  }

  if (input.alternates !== undefined) {
    metadata.alternates = normalizeAlternateMetadata(input.alternates, label);
  }

  return metadata;
}

function mergeMetadata(target: Metadata, next: Metadata): void {
  if (next.title !== undefined) {
    target.title = next.title;
  }

  if (next.description !== undefined) {
    target.description = next.description;
  }

  if (next.openGraph !== undefined) {
    target.openGraph = {
      ...(target.openGraph ?? {}),
      ...next.openGraph,
      images: next.openGraph.images ?? target.openGraph?.images,
    };
  }

  if (next.icons !== undefined) {
    target.icons = [...(target.icons ?? []), ...next.icons];
  }

  if (next.alternates !== undefined) {
    target.alternates = {
      ...(target.alternates ?? {}),
      ...next.alternates,
      languages: {
        ...(target.alternates?.languages ?? {}),
        ...(next.alternates.languages ?? {}),
      },
    };
  }
}

function normalizeOpenGraphMetadata(value: unknown, label: string): OpenGraphMetadata {
  const input = expectMetadataObject(value, `${label} metadata.openGraph`);
  const openGraph: OpenGraphMetadata = {};

  for (const key of ["title", "description", "url", "siteName", "type"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string") {
        throw new TypeError(`Ferrite ${label} metadata.openGraph.${key} must be a string.`);
      }
      openGraph[key] = input[key];
    }
  }

  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) {
      throw new TypeError(`Ferrite ${label} metadata.openGraph.images must be an array.`);
    }
    openGraph.images = input.images.map((image, index) => normalizeOpenGraphImage(image, label, index));
  }

  return openGraph;
}

function normalizeOpenGraphImage(value: unknown, label: string, index: number): OpenGraphImage {
  if (typeof value === "string") {
    return { url: value };
  }

  const input = expectMetadataObject(value, `${label} metadata.openGraph.images[${index}]`);
  if (typeof input.url !== "string") {
    throw new TypeError(`Ferrite ${label} metadata.openGraph.images[${index}].url must be a string.`);
  }

  const image: OpenGraphImage = { url: input.url };
  for (const key of ["alt"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string") {
        throw new TypeError(`Ferrite ${label} metadata.openGraph.images[${index}].${key} must be a string.`);
      }
      image[key] = input[key];
    }
  }

  for (const key of ["width", "height"] as const) {
    const dimension = input[key];
    if (dimension !== undefined) {
      if (typeof dimension !== "number" || !Number.isInteger(dimension) || dimension < 0) {
        throw new TypeError(
          `Ferrite ${label} metadata.openGraph.images[${index}].${key} must be a non-negative integer.`,
        );
      }
      image[key] = dimension;
    }
  }

  return image;
}

function normalizeIconMetadata(value: unknown, label: string): IconMetadata[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Ferrite ${label} metadata.icons must be an array.`);
  }

  return value.map((icon, index) => normalizeIconEntry(icon, label, index));
}

function normalizeIconEntry(value: unknown, label: string, index: number): IconMetadata {
  if (typeof value === "string") {
    return { url: value };
  }

  const input = expectMetadataObject(value, `${label} metadata.icons[${index}]`);
  if (typeof input.url !== "string") {
    throw new TypeError(`Ferrite ${label} metadata.icons[${index}].url must be a string.`);
  }

  const icon: IconMetadata = { url: input.url };
  for (const key of ["rel", "type", "sizes"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string") {
        throw new TypeError(`Ferrite ${label} metadata.icons[${index}].${key} must be a string.`);
      }
      icon[key] = input[key];
    }
  }

  return icon;
}

function normalizeAlternateMetadata(value: unknown, label: string): AlternateMetadata {
  const input = expectMetadataObject(value, `${label} metadata.alternates`);
  const alternates: AlternateMetadata = {};

  if (input.canonical !== undefined) {
    if (typeof input.canonical !== "string") {
      throw new TypeError(`Ferrite ${label} metadata.alternates.canonical must be a string.`);
    }
    alternates.canonical = input.canonical;
  }

  if (input.languages !== undefined) {
    const languages = expectMetadataObject(input.languages, `${label} metadata.alternates.languages`);
    alternates.languages = {};
    for (const [language, href] of Object.entries(languages).sort(([left], [right]) => left.localeCompare(right))) {
      if (typeof href !== "string") {
        throw new TypeError(`Ferrite ${label} metadata.alternates.languages.${language} must be a string.`);
      }
      alternates.languages[language] = href;
    }
  }

  return alternates;
}

function expectMetadataObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Ferrite ${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function createOpenGraphHead(openGraph: OpenGraphMetadata | undefined): Child[] {
  if (!openGraph) {
    return [];
  }

  const children: Child[] = [];
  pushMetaProperty(children, "og:title", openGraph.title);
  pushMetaProperty(children, "og:description", openGraph.description);
  pushMetaProperty(children, "og:url", openGraph.url);
  pushMetaProperty(children, "og:site_name", openGraph.siteName);
  pushMetaProperty(children, "og:type", openGraph.type);

  for (const image of openGraph.images ?? []) {
    pushMetaProperty(children, "og:image", image.url);
    pushMetaProperty(children, "og:image:alt", image.alt);
    pushMetaProperty(children, "og:image:width", image.width);
    pushMetaProperty(children, "og:image:height", image.height);
  }

  return children;
}

function createIconHead(icons: IconMetadata[] | undefined): Child[] {
  return (icons ?? []).map((icon) => {
    const props: Record<string, unknown> = {
      rel: icon.rel ?? "icon",
      href: icon.url,
    };
    if (icon.type) {
      props.type = icon.type;
    }
    if (icon.sizes) {
      props.sizes = icon.sizes;
    }
    return createServerElement("link", props);
  });
}

function createAlternateHead(alternates: AlternateMetadata | undefined): Child[] {
  if (!alternates) {
    return [];
  }

  const children: Child[] = [];
  if (alternates.canonical) {
    children.push(createServerElement("link", { rel: "canonical", href: alternates.canonical }));
  }

  for (const [hrefLang, href] of Object.entries(alternates.languages ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    children.push(createServerElement("link", { rel: "alternate", hreflang: hrefLang, href }));
  }

  return children;
}

function pushMetaProperty(children: Child[], property: string, content: string | number | undefined): void {
  if (content !== undefined) {
    children.push(createServerElement("meta", { property, content }));
  }
}

const serverHookDispatcher = {
  useState<S>(initial: S | (() => S)): [S, StateUpdater<S>] {
    const value = typeof initial === "function" ? (initial as () => S)() : initial;
    return [value, () => undefined];
  },
  useEffect(_effect: EffectCallback, _deps?: EffectDependencyList): void {
    return undefined;
  },
  useLayoutEffect(_effect: EffectCallback, _deps?: EffectDependencyList): void {
    return undefined;
  },
  useRef<T>(initial: T): RefObject<T> {
    return { current: initial };
  },
  useMemo<T>(factory: () => T, _deps?: MemoDependencyList): T {
    return factory();
  },
  useTransition(): [boolean, TransitionStartFunction] {
    return [false, (scope) => scope()];
  },
  useDeferredValue<T>(value: T): T {
    return value;
  },
};
