export const RENDER_PACKET_MARKER = "render-packet" as const;
export const RENDER_STREAM_MARKER = "render-stream" as const;
export const RENDER_PACKET_VERSION = 1 as const;
export const CLIENT_REFERENCE_MARKER = "client-reference" as const;
export const CLIENT_REFERENCE_VERSION = 1 as const;
export const SERVER_PAYLOAD_MARKER = "server-payload" as const;
export const SERVER_PAYLOAD_VERSION = 1 as const;
export const SERVER_PAYLOAD_STREAM_FRAME_MARKER = "server-payload-frame" as const;
export const SERVER_PAYLOAD_STREAM_FRAME_VERSION = 1 as const;
export const SERVER_ACTION_REFERENCE_MARKER = "server-action-reference" as const;
export const SERVER_ACTION_REFERENCE_VERSION = 1 as const;
export const SERVER_ACTION_REQUEST_MARKER = "server-action-request" as const;
export const SERVER_ACTION_REQUEST_VERSION = 1 as const;
export const SERVER_ACTION_RESPONSE_MARKER = "server-action-response" as const;
export const SERVER_ACTION_RESPONSE_VERSION = 1 as const;

export const COMPACT_TEXT_OPCODE = 0 as const;
export const COMPACT_FRAGMENT_OPCODE = 1 as const;
export const COMPACT_ELEMENT_OPCODE = 2 as const;

export type SerializableProp = string | number | boolean;

export type ClientReferenceSerializableValue =
  | string
  | number
  | boolean
  | null
  | ClientReferenceSerializableValue[]
  | { [key: string]: ClientReferenceSerializableValue };

export type SerializableNode =
  | {
      kind: "element";
      tag: string;
      props: Record<string, SerializableProp>;
      children: SerializableNode[];
    }
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "fragment";
      children: SerializableNode[];
    };

export type CompactNode =
  | [typeof COMPACT_TEXT_OPCODE, string]
  | [typeof COMPACT_FRAGMENT_OPCODE, CompactNode[]]
  | [typeof COMPACT_ELEMENT_OPCODE, string, Record<string, SerializableProp>, CompactNode[]];

export type RenderPacket = {
  ferrite: typeof RENDER_PACKET_MARKER;
  version: typeof RENDER_PACKET_VERSION;
  root: CompactNode;
};

export type RenderStreamChunk = {
  id: string;
  root: CompactNode;
};

export type RenderStreamPacket = {
  ferrite: typeof RENDER_STREAM_MARKER;
  version: typeof RENDER_PACKET_VERSION;
  shell: CompactNode;
  chunks: RenderStreamChunk[];
};

export type ClientReferencePayload = {
  ferrite: typeof CLIENT_REFERENCE_MARKER;
  version: typeof CLIENT_REFERENCE_VERSION;
  id: string;
  module: string;
  exportName: string;
  props: Record<string, ClientReferenceSerializableValue>;
};

export type ServerPayloadChunk = {
  id: string;
  root: CompactNode;
  clientReferences: ClientReferencePayload[];
};

export type ServerPayloadPacket = {
  ferrite: typeof SERVER_PAYLOAD_MARKER;
  version: typeof SERVER_PAYLOAD_VERSION;
  shell: CompactNode;
  clientReferences: ClientReferencePayload[];
  chunks: ServerPayloadChunk[];
};

export type ServerPayloadStreamShellFrame = {
  ferrite: typeof SERVER_PAYLOAD_STREAM_FRAME_MARKER;
  version: typeof SERVER_PAYLOAD_STREAM_FRAME_VERSION;
  kind: "shell";
  shell: CompactNode;
  clientReferences: ClientReferencePayload[];
};

export type ServerPayloadStreamChunkFrame = {
  ferrite: typeof SERVER_PAYLOAD_STREAM_FRAME_MARKER;
  version: typeof SERVER_PAYLOAD_STREAM_FRAME_VERSION;
  kind: "chunk";
  chunk: ServerPayloadChunk;
};

export type ServerPayloadStreamFrame = ServerPayloadStreamShellFrame | ServerPayloadStreamChunkFrame;

export type ServerActionFormValue = string | string[];

export type ServerActionReferencePayload = {
  ferrite: typeof SERVER_ACTION_REFERENCE_MARKER;
  version: typeof SERVER_ACTION_REFERENCE_VERSION;
  id: string;
  routePattern: string;
  url: string;
  bound: Record<string, ClientReferenceSerializableValue>;
};

export type ServerActionRequest = {
  ferrite: typeof SERVER_ACTION_REQUEST_MARKER;
  version: typeof SERVER_ACTION_REQUEST_VERSION;
  id: string;
  routePath: string;
  form: Record<string, ServerActionFormValue>;
};

export type ServerActionOkResponse = {
  ferrite: typeof SERVER_ACTION_RESPONSE_MARKER;
  version: typeof SERVER_ACTION_RESPONSE_VERSION;
  status: "ok";
  data: ClientReferenceSerializableValue;
};

export type ServerActionRedirectResponse = {
  ferrite: typeof SERVER_ACTION_RESPONSE_MARKER;
  version: typeof SERVER_ACTION_RESPONSE_VERSION;
  status: "redirect";
  location: string;
};

export type ServerActionErrorResponse = {
  ferrite: typeof SERVER_ACTION_RESPONSE_MARKER;
  version: typeof SERVER_ACTION_RESPONSE_VERSION;
  status: "error";
  message: string;
};

export type ServerActionPayloadResponse = {
  ferrite: typeof SERVER_ACTION_RESPONSE_MARKER;
  version: typeof SERVER_ACTION_RESPONSE_VERSION;
  status: "payload";
  payload: ServerPayloadPacket;
};

export type ServerActionResponse =
  | ServerActionOkResponse
  | ServerActionRedirectResponse
  | ServerActionErrorResponse
  | ServerActionPayloadResponse;

export function parseClientReferenceId(id: string): { module: string; exportName: string } {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Ferrite client reference requires a non-empty id.");
  }

  const separator = id.indexOf("#");
  if (separator === -1 || separator !== id.lastIndexOf("#")) {
    throw new TypeError("Ferrite client reference id must be formatted as module#exportName.");
  }

  const module = id.slice(0, separator);
  const exportName = id.slice(separator + 1);
  validateClientReferenceParts(id, module, exportName);
  return { module, exportName };
}

export function createClientReferencePayload(input: {
  id: string;
  props?: Record<string, ClientReferenceSerializableValue>;
}): ClientReferencePayload {
  const { module, exportName } = parseClientReferenceId(input.id);
  return {
    ferrite: CLIENT_REFERENCE_MARKER,
    version: CLIENT_REFERENCE_VERSION,
    id: input.id,
    module,
    exportName,
    props: input.props ?? {},
  };
}

export function createServerActionReferencePayload(input: {
  id: string;
  routePattern: string;
  url?: string;
  bound?: Record<string, ClientReferenceSerializableValue>;
}): ServerActionReferencePayload {
  const payload: ServerActionReferencePayload = {
    ferrite: SERVER_ACTION_REFERENCE_MARKER,
    version: SERVER_ACTION_REFERENCE_VERSION,
    id: input.id,
    routePattern: input.routePattern,
    url: input.url ?? "/_ferrite/action",
    bound: input.bound ?? {},
  };
  return validateServerActionReferencePayload(payload);
}

export function createServerActionRequest(input: {
  id: string;
  routePath: string;
  form?: Record<string, ServerActionFormValue>;
}): ServerActionRequest {
  const request: ServerActionRequest = {
    ferrite: SERVER_ACTION_REQUEST_MARKER,
    version: SERVER_ACTION_REQUEST_VERSION,
    id: input.id,
    routePath: input.routePath,
    form: input.form ?? {},
  };
  return validateServerActionRequest(request);
}

export function createServerActionOkResponse(input: {
  data?: ClientReferenceSerializableValue;
} = {}): ServerActionOkResponse {
  const response: ServerActionOkResponse = {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "ok",
    data: input.data ?? null,
  };
  return validateServerActionResponse(response) as ServerActionOkResponse;
}

export function createServerActionRedirectResponse(input: { location: string }): ServerActionRedirectResponse {
  const response: ServerActionRedirectResponse = {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "redirect",
    location: input.location,
  };
  return validateServerActionResponse(response) as ServerActionRedirectResponse;
}

export function createServerActionErrorResponse(input: { message: string }): ServerActionErrorResponse {
  const response: ServerActionErrorResponse = {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    message: input.message,
  };
  return validateServerActionResponse(response) as ServerActionErrorResponse;
}

export function createServerActionPayloadResponse(input: { payload: ServerPayloadPacket }): ServerActionPayloadResponse {
  const response: ServerActionPayloadResponse = {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "payload",
    payload: input.payload,
  };
  return validateServerActionResponse(response) as ServerActionPayloadResponse;
}

export function validateClientReferencePayload(payload: unknown): ClientReferencePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Ferrite client reference payload must be an object.");
  }

  const candidate = payload as Partial<ClientReferencePayload>;
  if (candidate.ferrite !== CLIENT_REFERENCE_MARKER) {
    throw new TypeError(`expected ferrite marker "${CLIENT_REFERENCE_MARKER}"`);
  }

  if (candidate.version !== CLIENT_REFERENCE_VERSION) {
    throw new TypeError(`unsupported client reference version ${String(candidate.version)}; expected ${CLIENT_REFERENCE_VERSION}`);
  }

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.module !== "string" ||
    typeof candidate.exportName !== "string"
  ) {
    throw new TypeError("Ferrite client reference payload requires string id, module, and exportName.");
  }

  validateClientReferenceParts(candidate.id, candidate.module, candidate.exportName);

  if (candidate.props === undefined) {
    candidate.props = {};
  }
  if (candidate.props === null || typeof candidate.props !== "object" || Array.isArray(candidate.props)) {
    throw new TypeError("Ferrite client reference payload props must be a JSON object.");
  }

  for (const [key, value] of Object.entries(candidate.props)) {
    validateClientReferenceSerializableValue(value, `props.${key}`);
  }

  return candidate as ClientReferencePayload;
}

export function validateServerActionReferencePayload(payload: unknown): ServerActionReferencePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Ferrite server action reference payload must be an object.");
  }

  const candidate = payload as Partial<ServerActionReferencePayload>;
  if (candidate.ferrite !== SERVER_ACTION_REFERENCE_MARKER) {
    throw new TypeError(`expected ferrite marker "${SERVER_ACTION_REFERENCE_MARKER}"`);
  }

  if (candidate.version !== SERVER_ACTION_REFERENCE_VERSION) {
    throw new TypeError(`unsupported server action reference version ${String(candidate.version)}; expected ${SERVER_ACTION_REFERENCE_VERSION}`);
  }

  if (typeof candidate.id !== "string") {
    throw new TypeError("Ferrite server action reference payload requires a string id.");
  }
  validateServerActionId(candidate.id);

  if (typeof candidate.routePattern !== "string") {
    throw new TypeError("Ferrite server action reference payload requires a string routePattern.");
  }
  validateServerActionRoutePath(candidate.routePattern);

  if (typeof candidate.url !== "string") {
    throw new TypeError("Ferrite server action reference payload requires a string url.");
  }
  validateServerActionUrl(candidate.url);

  if (candidate.bound === undefined) {
    candidate.bound = {};
  }
  if (candidate.bound === null || typeof candidate.bound !== "object" || Array.isArray(candidate.bound)) {
    throw new TypeError("Ferrite server action reference payload bound values must be a JSON object.");
  }
  for (const [key, value] of Object.entries(candidate.bound)) {
    if (key.length === 0) {
      throw new TypeError("server action bound argument name must be non-empty.");
    }
    validateClientReferenceSerializableValue(value, `bound.${key}`);
  }

  return candidate as ServerActionReferencePayload;
}

export function validateServerActionRequest(request: unknown): ServerActionRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Ferrite server action request must be an object.");
  }

  const candidate = request as Partial<ServerActionRequest>;
  if (candidate.ferrite !== SERVER_ACTION_REQUEST_MARKER) {
    throw new TypeError(`expected ferrite marker "${SERVER_ACTION_REQUEST_MARKER}"`);
  }

  if (candidate.version !== SERVER_ACTION_REQUEST_VERSION) {
    throw new TypeError(`unsupported server action request version ${String(candidate.version)}; expected ${SERVER_ACTION_REQUEST_VERSION}`);
  }

  if (typeof candidate.id !== "string") {
    throw new TypeError("Ferrite server action request requires a string id.");
  }
  validateServerActionId(candidate.id);

  if (typeof candidate.routePath !== "string") {
    throw new TypeError("Ferrite server action request requires a string routePath.");
  }
  validateServerActionRoutePath(candidate.routePath);

  if (candidate.form === undefined) {
    candidate.form = {};
  }
  if (candidate.form === null || typeof candidate.form !== "object" || Array.isArray(candidate.form)) {
    throw new TypeError("Ferrite server action request form must be a JSON object.");
  }
  for (const [key, value] of Object.entries(candidate.form)) {
    validateServerActionFormField(key, value);
  }

  return candidate as ServerActionRequest;
}

export function validateServerActionResponse(response: unknown): ServerActionResponse {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("Ferrite server action response must be an object.");
  }

  const candidate = response as Partial<ServerActionResponse>;
  if (candidate.ferrite !== SERVER_ACTION_RESPONSE_MARKER) {
    throw new TypeError(`expected ferrite marker "${SERVER_ACTION_RESPONSE_MARKER}"`);
  }

  if (candidate.version !== SERVER_ACTION_RESPONSE_VERSION) {
    throw new TypeError(`unsupported server action response version ${String(candidate.version)}; expected ${SERVER_ACTION_RESPONSE_VERSION}`);
  }

  if (candidate.status === "ok") {
    assertOnlyServerActionResponseFields(candidate, ["ferrite", "version", "status", "data"], "ok");
    validateClientReferenceSerializableValue((candidate as Partial<ServerActionOkResponse>).data ?? null, "data");
    if ((candidate as Partial<ServerActionOkResponse>).data === undefined) {
      (candidate as Partial<ServerActionOkResponse>).data = null;
    }
    return candidate as ServerActionOkResponse;
  }

    if (candidate.status === "redirect") {
    assertOnlyServerActionResponseFields(candidate, ["ferrite", "version", "status", "location"], "redirect");
    const location = (candidate as Partial<ServerActionRedirectResponse>).location;
    if (typeof location !== "string" || location.length === 0) {
      throw new TypeError("server action redirect location must be non-empty.");
    }
    validateServerActionUrl(location);
    return candidate as ServerActionRedirectResponse;
  }

  if (candidate.status === "error") {
    assertOnlyServerActionResponseFields(candidate, ["ferrite", "version", "status", "message"], "error");
    const message = (candidate as Partial<ServerActionErrorResponse>).message;
    if (typeof message !== "string" || message.length === 0) {
      throw new TypeError("server action error message must be non-empty.");
    }
    return candidate as ServerActionErrorResponse;
  }

  if (candidate.status === "payload") {
    assertOnlyServerActionResponseFields(candidate, ["ferrite", "version", "status", "payload"], "payload");
    (candidate as Partial<ServerActionPayloadResponse>).payload = validateServerPayloadPacket(
      (candidate as Partial<ServerActionPayloadResponse>).payload,
    );
    return candidate as ServerActionPayloadResponse;
  }

  throw new TypeError(`unsupported server action response status ${String(candidate.status)}`);
}

export function validateServerPayloadPacket(payload: unknown): ServerPayloadPacket {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Ferrite server payload must be an object.");
  }

  const candidate = payload as Partial<ServerPayloadPacket>;
  if (candidate.ferrite !== SERVER_PAYLOAD_MARKER) {
    throw new TypeError(`expected ferrite marker "${SERVER_PAYLOAD_MARKER}"`);
  }

  if (candidate.version !== SERVER_PAYLOAD_VERSION) {
    throw new TypeError(`unsupported server payload version ${String(candidate.version)}; expected ${SERVER_PAYLOAD_VERSION}`);
  }

  if (!Array.isArray(candidate.clientReferences)) {
    throw new TypeError("Ferrite server payload clientReferences must be an array.");
  }

  if (!Array.isArray(candidate.chunks)) {
    throw new TypeError("Ferrite server payload chunks must be an array.");
  }

  candidate.clientReferences = candidate.clientReferences.map(validateClientReferencePayload);
  candidate.chunks = candidate.chunks.map((chunk, index) => validateServerPayloadChunk(chunk, index));

  return candidate as ServerPayloadPacket;
}

export function validateServerPayloadStreamFrame(frame: unknown): ServerPayloadStreamFrame {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw new TypeError("Ferrite server payload stream frame must be an object.");
  }

  const candidate = frame as Partial<ServerPayloadStreamFrame>;
  if (candidate.ferrite !== SERVER_PAYLOAD_STREAM_FRAME_MARKER) {
    throw new TypeError(`expected ferrite marker "${SERVER_PAYLOAD_STREAM_FRAME_MARKER}"`);
  }

  if (candidate.version !== SERVER_PAYLOAD_STREAM_FRAME_VERSION) {
    throw new TypeError(`unsupported server payload stream frame version ${String(candidate.version)}; expected ${SERVER_PAYLOAD_STREAM_FRAME_VERSION}`);
  }

  if (candidate.kind === "shell") {
    return validateServerPayloadStreamShellFrame(candidate as Partial<ServerPayloadStreamShellFrame>);
  }
  if (candidate.kind === "chunk") {
    return validateServerPayloadStreamChunkFrame(candidate as Partial<ServerPayloadStreamChunkFrame>);
  }

  throw new TypeError(`unsupported server payload stream frame kind ${String(candidate.kind)}`);
}

function validateServerPayloadStreamShellFrame(
  frame: Partial<ServerPayloadStreamShellFrame>,
): ServerPayloadStreamShellFrame {
  if (!Array.isArray(frame.shell)) {
    throw new TypeError("Ferrite server payload stream shell frame requires a compact shell.");
  }
  if (!Array.isArray(frame.clientReferences)) {
    throw new TypeError("Ferrite server payload stream shell frame clientReferences must be an array.");
  }

  frame.clientReferences = frame.clientReferences.map(validateClientReferencePayload);
  return frame as ServerPayloadStreamShellFrame;
}

function validateServerPayloadStreamChunkFrame(
  frame: Partial<ServerPayloadStreamChunkFrame>,
): ServerPayloadStreamChunkFrame {
  frame.chunk = validateServerPayloadChunk(frame.chunk, 0);
  return frame as ServerPayloadStreamChunkFrame;
}

function validateServerPayloadChunk(chunk: unknown, index: number): ServerPayloadChunk {
  if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) {
    throw new TypeError(`Ferrite server payload chunk ${index} must be an object.`);
  }

  const candidate = chunk as Partial<ServerPayloadChunk>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new TypeError(`Ferrite server payload chunk ${index} requires a non-empty id.`);
  }
  validateStreamChunkId(candidate.id);

  if (!Array.isArray(candidate.clientReferences)) {
    throw new TypeError(`Ferrite server payload chunk ${index} clientReferences must be an array.`);
  }
  candidate.clientReferences = candidate.clientReferences.map(validateClientReferencePayload);
  return candidate as ServerPayloadChunk;
}

function validateStreamChunkId(id: string): void {
  if (!/^[A-Za-z0-9_:-]+$/.test(id)) {
    throw new TypeError(`invalid stream chunk id "${id}"`);
  }
}

function validateServerActionId(id: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("server action id must be non-empty.");
  }

  const separator = id.indexOf("#");
  if (separator === -1 || separator !== id.lastIndexOf("#")) {
    throw new TypeError("server action id must be formatted as module#exportName.");
  }

  const module = id.slice(0, separator);
  const exportName = id.slice(separator + 1);
  validateClientReferenceModule(module);
  validateClientReferenceExportName(exportName);
}

function validateServerActionRoutePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new TypeError("server action route path must start with `/`.");
  }
  if (path.includes("\\") || path.includes("?") || /[\u0000-\u001F\u007F]/.test(path)) {
    throw new TypeError(`invalid server action route path "${path}"`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(`invalid server action route path "${path}"`);
  }
}

function validateServerActionUrl(url: string): void {
  if (!url.startsWith("/")) {
    throw new TypeError("server action url must start with `/`.");
  }
  if (url.includes("\\") || /[\u0000-\u001F\u007F]/.test(url)) {
    throw new TypeError(`invalid server action url "${url}"`);
  }
}

function validateServerActionFormField(name: string, value: unknown): void {
  if (name.length === 0) {
    throw new TypeError("server action form field name must be non-empty.");
  }
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return;
  }
  throw new TypeError(`server action form field "${name}" must be a string or string array.`);
}

function assertOnlyServerActionResponseFields(
  candidate: object,
  allowedFields: string[],
  status: string,
): void {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Ferrite server action ${status} response has unsupported field "${key}".`);
    }
  }
}

export function validateClientReferenceParts(id: string, module: string, exportName: string): void {
  validateClientReferenceModule(module);
  validateClientReferenceExportName(exportName);
  const expectedId = `${module}#${exportName}`;
  if (id !== expectedId) {
    throw new TypeError(`client reference id must equal "${expectedId}"`);
  }
}

function validateClientReferenceModule(module: string): void {
  if (typeof module !== "string" || module.length === 0) {
    throw new TypeError("client reference module must be non-empty.");
  }
  if (module.startsWith("/") || module.includes("\\") || module.includes("#")) {
    throw new TypeError(`invalid client reference module "${module}"`);
  }

  const segments = module.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`invalid client reference module "${module}"`);
  }
}

function validateClientReferenceExportName(exportName: string): void {
  if (exportName === "default" || exportName === "*") {
    return;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) {
    throw new TypeError(`invalid client reference export "${exportName}"`);
  }
}

function validateClientReferenceSerializableValue(
  value: ClientReferenceSerializableValue,
  path: string,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throw new TypeError(`Ferrite client reference ${path} must be JSON-serializable.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateClientReferenceSerializableValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      validateClientReferenceSerializableValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`Ferrite client reference ${path} must be JSON-serializable.`);
}
