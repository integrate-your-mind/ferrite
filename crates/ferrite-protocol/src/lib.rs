use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RENDER_PACKET_MARKER: &str = "render-packet";
pub const RENDER_STREAM_MARKER: &str = "render-stream";
pub const CLIENT_REFERENCE_MARKER: &str = "client-reference";
pub const SERVER_PAYLOAD_MARKER: &str = "server-payload";
pub const SERVER_PAYLOAD_STREAM_FRAME_MARKER: &str = "server-payload-frame";
pub const SERVER_ACTION_REFERENCE_MARKER: &str = "server-action-reference";
pub const SERVER_ACTION_REQUEST_MARKER: &str = "server-action-request";
pub const SERVER_ACTION_RESPONSE_MARKER: &str = "server-action-response";
pub const RENDER_PACKET_VERSION: u64 = 1;
pub const CLIENT_REFERENCE_VERSION: u64 = 1;
pub const SERVER_PAYLOAD_VERSION: u64 = 1;
pub const SERVER_PAYLOAD_STREAM_FRAME_VERSION: u64 = 1;
pub const SERVER_ACTION_REFERENCE_VERSION: u64 = 1;
pub const SERVER_ACTION_REQUEST_VERSION: u64 = 1;
pub const SERVER_ACTION_RESPONSE_VERSION: u64 = 1;
pub const COMPACT_TEXT_OPCODE: u8 = 0;
pub const COMPACT_FRAGMENT_OPCODE: u8 = 1;
pub const COMPACT_ELEMENT_OPCODE: u8 = 2;

pub fn typescript_protocol_source() -> String {
    let mut out = String::new();
    writeln!(
        out,
        "export const RENDER_PACKET_MARKER = {} as const;",
        serde_json::to_string(RENDER_PACKET_MARKER).expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const RENDER_STREAM_MARKER = {} as const;",
        serde_json::to_string(RENDER_STREAM_MARKER).expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const RENDER_PACKET_VERSION = {RENDER_PACKET_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const CLIENT_REFERENCE_MARKER = {} as const;",
        serde_json::to_string(CLIENT_REFERENCE_MARKER).expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const CLIENT_REFERENCE_VERSION = {CLIENT_REFERENCE_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_PAYLOAD_MARKER = {} as const;",
        serde_json::to_string(SERVER_PAYLOAD_MARKER).expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_PAYLOAD_VERSION = {SERVER_PAYLOAD_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_PAYLOAD_STREAM_FRAME_MARKER = {} as const;",
        serde_json::to_string(SERVER_PAYLOAD_STREAM_FRAME_MARKER)
            .expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_PAYLOAD_STREAM_FRAME_VERSION = {SERVER_PAYLOAD_STREAM_FRAME_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_REFERENCE_MARKER = {} as const;",
        serde_json::to_string(SERVER_ACTION_REFERENCE_MARKER)
            .expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_REFERENCE_VERSION = {SERVER_ACTION_REFERENCE_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_REQUEST_MARKER = {} as const;",
        serde_json::to_string(SERVER_ACTION_REQUEST_MARKER)
            .expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_REQUEST_VERSION = {SERVER_ACTION_REQUEST_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_RESPONSE_MARKER = {} as const;",
        serde_json::to_string(SERVER_ACTION_RESPONSE_MARKER)
            .expect("string serialization cannot fail")
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const SERVER_ACTION_RESPONSE_VERSION = {SERVER_ACTION_RESPONSE_VERSION} as const;"
    )
    .expect("writing to a string cannot fail");
    out.push('\n');
    writeln!(
        out,
        "export const COMPACT_TEXT_OPCODE = {COMPACT_TEXT_OPCODE} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const COMPACT_FRAGMENT_OPCODE = {COMPACT_FRAGMENT_OPCODE} as const;"
    )
    .expect("writing to a string cannot fail");
    writeln!(
        out,
        "export const COMPACT_ELEMENT_OPCODE = {COMPACT_ELEMENT_OPCODE} as const;"
    )
    .expect("writing to a string cannot fail");
    out.push_str(
        r##"
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
  code?: string;
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

export function createServerActionErrorResponse(input: { code: string; message: string }): ServerActionErrorResponse {
  const response: ServerActionErrorResponse = {
    ferrite: SERVER_ACTION_RESPONSE_MARKER,
    version: SERVER_ACTION_RESPONSE_VERSION,
    status: "error",
    code: input.code,
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
    assertOnlyServerActionResponseFields(candidate, ["ferrite", "version", "status", "code", "message"], "error");
    const code = (candidate as Partial<ServerActionErrorResponse>).code;
    if (code !== undefined) {
      validateServerActionErrorCode(code);
    }
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

function validateServerActionErrorCode(code: unknown): asserts code is string {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new TypeError("server action error code must be 1-64 uppercase ASCII letters, digits, or underscores and start with a letter.");
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
"##,
    );
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    message: String,
}

impl ProtocolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProtocolError {}

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SerializableProp {
    String(String),
    Bool(bool),
    Number(f64),
}

pub type ClientReferenceProps = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPacket {
    pub ferrite: String,
    pub version: u64,
    pub root: CompactNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderStreamPacket {
    pub ferrite: String,
    pub version: u64,
    pub shell: CompactNode,
    #[serde(default)]
    pub chunks: Vec<RenderStreamChunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderStreamChunk {
    pub id: String,
    pub root: CompactNode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientReferencePayload {
    pub ferrite: String,
    pub version: u64,
    pub id: String,
    pub module: String,
    pub export_name: String,
    #[serde(default)]
    pub props: ClientReferenceProps,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayloadPacket {
    pub ferrite: String,
    pub version: u64,
    pub shell: CompactNode,
    #[serde(default)]
    pub client_references: Vec<ClientReferencePayload>,
    #[serde(default)]
    pub chunks: Vec<ServerPayloadChunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayloadChunk {
    pub id: String,
    pub root: CompactNode,
    #[serde(default)]
    pub client_references: Vec<ClientReferencePayload>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayloadStreamShellFrame {
    pub ferrite: String,
    pub version: u64,
    pub kind: String,
    pub shell: CompactNode,
    #[serde(default)]
    pub client_references: Vec<ClientReferencePayload>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPayloadStreamChunkFrame {
    pub ferrite: String,
    pub version: u64,
    pub kind: String,
    pub chunk: ServerPayloadChunk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerActionFormValue {
    String(String),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionReferencePayload {
    pub ferrite: String,
    pub version: u64,
    pub id: String,
    pub route_pattern: String,
    pub url: String,
    #[serde(default)]
    pub bound: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionRequest {
    pub ferrite: String,
    pub version: u64,
    pub id: String,
    pub route_path: String,
    #[serde(default)]
    pub form: BTreeMap<String, ServerActionFormValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionResponse {
    pub ferrite: String,
    pub version: u64,
    #[serde(flatten)]
    pub outcome: ServerActionResponseOutcome,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum ServerActionResponseOutcome {
    #[serde(rename = "ok")]
    Ok { data: Value },
    #[serde(rename = "redirect")]
    Redirect { location: String },
    #[serde(rename = "error")]
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        message: String,
    },
    #[serde(rename = "payload")]
    Payload { payload: ServerPayloadPacket },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CompactNode {
    Text((u8, String)),
    Fragment((u8, Vec<CompactNode>)),
    Element(
        (
            u8,
            String,
            BTreeMap<String, SerializableProp>,
            Vec<CompactNode>,
        ),
    ),
}

pub fn ferrite_marker(value: &Value) -> Result<Option<&str>> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };

    let Some(marker) = object.get("ferrite") else {
        return Ok(None);
    };

    marker
        .as_str()
        .map(Some)
        .ok_or_else(|| ProtocolError::new("ferrite marker must be a string"))
}

pub fn looks_like_ferrite_payload(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.contains_key("version")
            || object.contains_key("root")
            || object.contains_key("shell")
            || object.contains_key("chunks")
            || object.contains_key("module")
            || object.contains_key("exportName")
            || object.contains_key("clientReferences")
    })
}

pub fn validate_packet(packet: &RenderPacket) -> Result<()> {
    if packet.ferrite != RENDER_PACKET_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{RENDER_PACKET_MARKER}\""
        )));
    }

    if packet.version != RENDER_PACKET_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported version {}; expected {RENDER_PACKET_VERSION}",
            packet.version
        )));
    }

    Ok(())
}

pub fn validate_stream_packet(packet: &RenderStreamPacket) -> Result<()> {
    if packet.ferrite != RENDER_STREAM_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{RENDER_STREAM_MARKER}\""
        )));
    }

    if packet.version != RENDER_PACKET_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported version {}; expected {RENDER_PACKET_VERSION}",
            packet.version
        )));
    }

    Ok(())
}

pub fn validate_chunk_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_' | ':'))
    {
        return Err(ProtocolError::new(format!(
            "invalid stream chunk id \"{id}\""
        )));
    }

    Ok(())
}

pub fn validate_client_reference_payload(payload: &ClientReferencePayload) -> Result<()> {
    if payload.ferrite != CLIENT_REFERENCE_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{CLIENT_REFERENCE_MARKER}\""
        )));
    }

    if payload.version != CLIENT_REFERENCE_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported client reference version {}; expected {CLIENT_REFERENCE_VERSION}",
            payload.version
        )));
    }

    validate_client_reference_parts(&payload.id, &payload.module, &payload.export_name)?;

    for (key, value) in &payload.props {
        validate_client_reference_value(value, &format!("props.{key}"))?;
    }

    Ok(())
}

pub fn validate_server_payload_packet(packet: &ServerPayloadPacket) -> Result<()> {
    if packet.ferrite != SERVER_PAYLOAD_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{SERVER_PAYLOAD_MARKER}\""
        )));
    }

    if packet.version != SERVER_PAYLOAD_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported server payload version {}; expected {SERVER_PAYLOAD_VERSION}",
            packet.version
        )));
    }

    for reference in &packet.client_references {
        validate_client_reference_payload(reference)?;
    }

    for chunk in &packet.chunks {
        validate_chunk_id(&chunk.id)?;
        for reference in &chunk.client_references {
            validate_client_reference_payload(reference)?;
        }
    }

    Ok(())
}

pub fn validate_server_payload_stream_shell_frame(
    frame: &ServerPayloadStreamShellFrame,
) -> Result<()> {
    validate_server_payload_stream_frame_header(
        &frame.ferrite,
        frame.version,
        &frame.kind,
        "shell",
    )?;

    for reference in &frame.client_references {
        validate_client_reference_payload(reference)?;
    }

    Ok(())
}

pub fn validate_server_payload_stream_chunk_frame(
    frame: &ServerPayloadStreamChunkFrame,
) -> Result<()> {
    validate_server_payload_stream_frame_header(
        &frame.ferrite,
        frame.version,
        &frame.kind,
        "chunk",
    )?;
    validate_chunk_id(&frame.chunk.id)?;
    for reference in &frame.chunk.client_references {
        validate_client_reference_payload(reference)?;
    }

    Ok(())
}

pub fn validate_server_action_reference_payload(
    payload: &ServerActionReferencePayload,
) -> Result<()> {
    if payload.ferrite != SERVER_ACTION_REFERENCE_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{SERVER_ACTION_REFERENCE_MARKER}\""
        )));
    }

    if payload.version != SERVER_ACTION_REFERENCE_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported server action reference version {}; expected {SERVER_ACTION_REFERENCE_VERSION}",
            payload.version
        )));
    }

    validate_server_action_id(&payload.id)?;
    validate_server_action_route_path(&payload.route_pattern)?;
    validate_server_action_url(&payload.url)?;
    for (key, value) in &payload.bound {
        if key.is_empty() {
            return Err(ProtocolError::new(
                "server action bound argument name must be non-empty.",
            ));
        }
        validate_client_reference_value(value, &format!("bound.{key}"))?;
    }

    Ok(())
}

pub fn validate_server_action_request(request: &ServerActionRequest) -> Result<()> {
    if request.ferrite != SERVER_ACTION_REQUEST_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{SERVER_ACTION_REQUEST_MARKER}\""
        )));
    }

    if request.version != SERVER_ACTION_REQUEST_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported server action request version {}; expected {SERVER_ACTION_REQUEST_VERSION}",
            request.version
        )));
    }

    validate_server_action_id(&request.id)?;
    validate_server_action_route_path(&request.route_path)?;
    for (key, value) in &request.form {
        validate_server_action_form_field(key, value)?;
    }

    Ok(())
}

pub fn validate_server_action_response(response: &ServerActionResponse) -> Result<()> {
    if response.ferrite != SERVER_ACTION_RESPONSE_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{SERVER_ACTION_RESPONSE_MARKER}\""
        )));
    }

    if response.version != SERVER_ACTION_RESPONSE_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported server action response version {}; expected {SERVER_ACTION_RESPONSE_VERSION}",
            response.version
        )));
    }

    match &response.outcome {
        ServerActionResponseOutcome::Ok { data } => {
            validate_client_reference_value(data, "data")?;
        }
        ServerActionResponseOutcome::Redirect { location } => {
            if location.is_empty() {
                return Err(ProtocolError::new(
                    "server action redirect location must be non-empty.",
                ));
            }
            validate_server_action_url(location)?;
        }
        ServerActionResponseOutcome::Error { code, message } => {
            if let Some(code) = code {
                validate_server_action_error_code(code)?;
            }
            if message.is_empty() {
                return Err(ProtocolError::new(
                    "server action error message must be non-empty.",
                ));
            }
        }
        ServerActionResponseOutcome::Payload { payload } => {
            validate_server_payload_packet(payload)?;
        }
    }

    Ok(())
}

fn validate_server_payload_stream_frame_header(
    ferrite: &str,
    version: u64,
    kind: &str,
    expected_kind: &str,
) -> Result<()> {
    if ferrite != SERVER_PAYLOAD_STREAM_FRAME_MARKER {
        return Err(ProtocolError::new(format!(
            "expected ferrite marker \"{SERVER_PAYLOAD_STREAM_FRAME_MARKER}\""
        )));
    }

    if version != SERVER_PAYLOAD_STREAM_FRAME_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported server payload stream frame version {}; expected {SERVER_PAYLOAD_STREAM_FRAME_VERSION}",
            version
        )));
    }

    if kind != expected_kind {
        return Err(ProtocolError::new(format!(
            "expected server payload stream frame kind \"{expected_kind}\""
        )));
    }

    Ok(())
}

fn validate_server_action_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(ProtocolError::new("server action id must be non-empty."));
    }

    let Some(separator) = id.find('#') else {
        return Err(ProtocolError::new(
            "server action id must be formatted as module#exportName.",
        ));
    };
    if separator != id.rfind('#').expect("separator found above") {
        return Err(ProtocolError::new(
            "server action id must be formatted as module#exportName.",
        ));
    }

    let module = &id[..separator];
    let export_name = &id[separator + 1..];
    validate_client_reference_module(module)?;
    validate_client_reference_export_name(export_name)?;

    Ok(())
}

fn validate_server_action_route_path(path: &str) -> Result<()> {
    if !path.starts_with('/') {
        return Err(ProtocolError::new(
            "server action route path must start with `/`.",
        ));
    }

    if path.contains('\\') || path.contains('?') || path.chars().any(char::is_control) {
        return Err(ProtocolError::new(format!(
            "invalid server action route path \"{path}\""
        )));
    }

    if path.split('/').any(|segment| matches!(segment, "." | "..")) {
        return Err(ProtocolError::new(format!(
            "invalid server action route path \"{path}\""
        )));
    }

    Ok(())
}

fn validate_server_action_url(url: &str) -> Result<()> {
    if !url.starts_with('/') {
        return Err(ProtocolError::new("server action url must start with `/`."));
    }

    if url.contains('\\') || url.chars().any(char::is_control) {
        return Err(ProtocolError::new(format!(
            "invalid server action url \"{url}\""
        )));
    }

    Ok(())
}

fn validate_server_action_error_code(code: &str) -> Result<()> {
    let mut bytes = code.bytes();
    let valid = code.len() <= 64
        && bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if !valid {
        return Err(ProtocolError::new(
            "server action error code must be 1-64 uppercase ASCII letters, digits, or underscores and start with a letter.",
        ));
    }
    Ok(())
}

fn validate_server_action_form_field(name: &str, value: &ServerActionFormValue) -> Result<()> {
    if name.is_empty() {
        return Err(ProtocolError::new(
            "server action form field name must be non-empty.",
        ));
    }

    match value {
        ServerActionFormValue::String(_) => Ok(()),
        ServerActionFormValue::List(_) => Ok(()),
    }
}

pub fn validate_client_reference_parts(id: &str, module: &str, export_name: &str) -> Result<()> {
    validate_client_reference_module(module)?;
    validate_client_reference_export_name(export_name)?;

    let expected_id = format!("{module}#{export_name}");
    if id != expected_id {
        return Err(ProtocolError::new(format!(
            "client reference id must equal \"{expected_id}\""
        )));
    }

    Ok(())
}

fn validate_client_reference_module(module: &str) -> Result<()> {
    if module.is_empty() {
        return Err(ProtocolError::new(
            "client reference module must be non-empty.",
        ));
    }

    if module.starts_with('/') || module.contains('\\') || module.contains('#') {
        return Err(ProtocolError::new(format!(
            "invalid client reference module \"{module}\""
        )));
    }

    if module
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(ProtocolError::new(format!(
            "invalid client reference module \"{module}\""
        )));
    }

    Ok(())
}

fn validate_client_reference_export_name(export_name: &str) -> Result<()> {
    if matches!(export_name, "default" | "*") {
        return Ok(());
    }

    let mut chars = export_name.chars();
    let Some(first) = chars.next() else {
        return Err(ProtocolError::new("invalid client reference export \"\""));
    };

    if !(first.is_ascii_alphabetic() || matches!(first, '_' | '$'))
        || !chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '_' | '$'))
    {
        return Err(ProtocolError::new(format!(
            "invalid client reference export \"{export_name}\""
        )));
    }

    Ok(())
}

fn validate_client_reference_value(value: &Value, path: &str) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) | Value::Number(_) => Ok(()),
        Value::Array(items) => items.iter().enumerate().try_for_each(|(index, item)| {
            validate_client_reference_value(item, &format!("{path}[{index}]"))
        }),
        Value::Object(object) => object.iter().try_for_each(|(key, child)| {
            validate_client_reference_value(child, &format!("{path}.{key}"))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn validates_render_packet_markers_and_versions() {
        let packet = RenderPacket {
            ferrite: RENDER_PACKET_MARKER.to_owned(),
            version: RENDER_PACKET_VERSION,
            root: CompactNode::Text((0, "ok".to_owned())),
        };

        assert!(validate_packet(&packet).is_ok());

        let mut wrong_marker = packet.clone();
        wrong_marker.ferrite = "other".to_owned();
        assert_eq!(
            validate_packet(&wrong_marker).unwrap_err().message(),
            "expected ferrite marker \"render-packet\""
        );

        let mut wrong_version = packet;
        wrong_version.version = 2;
        assert_eq!(
            validate_packet(&wrong_version).unwrap_err().message(),
            "unsupported version 2; expected 1"
        );
    }

    #[test]
    fn validates_stream_packet_markers_versions_and_chunk_ids() {
        let packet = RenderStreamPacket {
            ferrite: RENDER_STREAM_MARKER.to_owned(),
            version: RENDER_PACKET_VERSION,
            shell: CompactNode::Text((0, "shell".to_owned())),
            chunks: vec![RenderStreamChunk {
                id: "s0".to_owned(),
                root: CompactNode::Text((0, "chunk".to_owned())),
            }],
        };

        assert!(validate_stream_packet(&packet).is_ok());
        assert!(validate_chunk_id(&packet.chunks[0].id).is_ok());

        assert_eq!(
            validate_chunk_id("bad id").unwrap_err().message(),
            "invalid stream chunk id \"bad id\""
        );
    }

    #[test]
    fn detects_ferrite_payload_shapes() {
        let value: Value = serde_json::from_str(
            r#"{ "ferrite": "render-stream", "version": 1, "shell": [0, "ok"] }"#,
        )
        .unwrap();

        assert_eq!(ferrite_marker(&value).unwrap(), Some(RENDER_STREAM_MARKER));
        assert!(looks_like_ferrite_payload(&value));

        let marker_error: Value = serde_json::from_str(r#"{ "ferrite": 1 }"#).unwrap();
        assert_eq!(
            ferrite_marker(&marker_error).unwrap_err().message(),
            "ferrite marker must be a string"
        );
    }

    #[test]
    fn validates_client_reference_payloads() {
        let payload = ClientReferencePayload {
            ferrite: CLIENT_REFERENCE_MARKER.to_owned(),
            version: CLIENT_REFERENCE_VERSION,
            id: "app/posts/[id]/PostActions.tsx#default".to_owned(),
            module: "app/posts/[id]/PostActions.tsx".to_owned(),
            export_name: "default".to_owned(),
            props: BTreeMap::from([("id".to_owned(), Value::String("alpha".to_owned()))]),
        };

        assert!(validate_client_reference_payload(&payload).is_ok());
        assert!(
            validate_client_reference_parts(
                "app/Button.tsx#ShareButton",
                "app/Button.tsx",
                "ShareButton"
            )
            .is_ok()
        );
        assert!(validate_client_reference_parts("app/Button.tsx#*", "app/Button.tsx", "*").is_ok());

        let mut wrong_marker = payload.clone();
        wrong_marker.ferrite = "other".to_owned();
        assert_eq!(
            validate_client_reference_payload(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"client-reference\""
        );

        let mut wrong_version = payload.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_client_reference_payload(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported client reference version 99; expected 1"
        );

        let mut id_mismatch = payload.clone();
        id_mismatch.id = "app/posts/[id]/PostActions.tsx#Other".to_owned();
        assert_eq!(
            validate_client_reference_payload(&id_mismatch)
                .unwrap_err()
                .message(),
            "client reference id must equal \"app/posts/[id]/PostActions.tsx#default\""
        );

        assert_eq!(
            validate_client_reference_parts(
                "/app/Button.tsx#default",
                "/app/Button.tsx",
                "default"
            )
            .unwrap_err()
            .message(),
            "invalid client reference module \"/app/Button.tsx\""
        );

        assert_eq!(
            validate_client_reference_parts(
                "app/Button.tsx#bad-name",
                "app/Button.tsx",
                "bad-name"
            )
            .unwrap_err()
            .message(),
            "invalid client reference export \"bad-name\""
        );
    }

    #[test]
    fn validates_server_payload_packets() {
        let reference = ClientReferencePayload {
            ferrite: CLIENT_REFERENCE_MARKER.to_owned(),
            version: CLIENT_REFERENCE_VERSION,
            id: "app/Button.tsx#default".to_owned(),
            module: "app/Button.tsx".to_owned(),
            export_name: "default".to_owned(),
            props: BTreeMap::from([("id".to_owned(), Value::String("alpha".to_owned()))]),
        };
        let packet = ServerPayloadPacket {
            ferrite: SERVER_PAYLOAD_MARKER.to_owned(),
            version: SERVER_PAYLOAD_VERSION,
            shell: CompactNode::Text((0, "shell".to_owned())),
            client_references: vec![reference.clone()],
            chunks: vec![ServerPayloadChunk {
                id: "s0".to_owned(),
                root: CompactNode::Text((0, "chunk".to_owned())),
                client_references: vec![reference],
            }],
        };

        assert!(validate_server_payload_packet(&packet).is_ok());

        let mut wrong_marker = packet.clone();
        wrong_marker.ferrite = "other".to_owned();
        assert_eq!(
            validate_server_payload_packet(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"server-payload\""
        );

        let mut wrong_version = packet.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_server_payload_packet(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported server payload version 99; expected 1"
        );

        let mut bad_chunk = packet.clone();
        bad_chunk.chunks[0].id = "bad id".to_owned();
        assert_eq!(
            validate_server_payload_packet(&bad_chunk)
                .unwrap_err()
                .message(),
            "invalid stream chunk id \"bad id\""
        );

        let mut bad_reference = packet.clone();
        bad_reference.client_references[0].id = "app/Button.tsx#Other".to_owned();
        assert_eq!(
            validate_server_payload_packet(&bad_reference)
                .unwrap_err()
                .message(),
            "client reference id must equal \"app/Button.tsx#default\""
        );
    }

    #[test]
    fn validates_server_payload_stream_frames() {
        let reference = ClientReferencePayload {
            ferrite: CLIENT_REFERENCE_MARKER.to_owned(),
            version: CLIENT_REFERENCE_VERSION,
            id: "app/Button.tsx#default".to_owned(),
            module: "app/Button.tsx".to_owned(),
            export_name: "default".to_owned(),
            props: BTreeMap::from([("id".to_owned(), Value::String("alpha".to_owned()))]),
        };
        let shell = ServerPayloadStreamShellFrame {
            ferrite: SERVER_PAYLOAD_STREAM_FRAME_MARKER.to_owned(),
            version: SERVER_PAYLOAD_STREAM_FRAME_VERSION,
            kind: "shell".to_owned(),
            shell: CompactNode::Text((0, "shell".to_owned())),
            client_references: vec![reference.clone()],
        };
        let chunk = ServerPayloadStreamChunkFrame {
            ferrite: SERVER_PAYLOAD_STREAM_FRAME_MARKER.to_owned(),
            version: SERVER_PAYLOAD_STREAM_FRAME_VERSION,
            kind: "chunk".to_owned(),
            chunk: ServerPayloadChunk {
                id: "s0".to_owned(),
                root: CompactNode::Text((0, "chunk".to_owned())),
                client_references: vec![reference],
            },
        };

        assert!(validate_server_payload_stream_shell_frame(&shell).is_ok());
        assert!(validate_server_payload_stream_chunk_frame(&chunk).is_ok());

        let mut wrong_marker = shell.clone();
        wrong_marker.ferrite = "server-payload".to_owned();
        assert_eq!(
            validate_server_payload_stream_shell_frame(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"server-payload-frame\""
        );

        let mut wrong_version = shell.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_server_payload_stream_shell_frame(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported server payload stream frame version 99; expected 1"
        );

        let mut wrong_kind = chunk.clone();
        wrong_kind.kind = "shell".to_owned();
        assert_eq!(
            validate_server_payload_stream_chunk_frame(&wrong_kind)
                .unwrap_err()
                .message(),
            "expected server payload stream frame kind \"chunk\""
        );

        let mut bad_chunk = chunk;
        bad_chunk.chunk.id = "bad id".to_owned();
        assert_eq!(
            validate_server_payload_stream_chunk_frame(&bad_chunk)
                .unwrap_err()
                .message(),
            "invalid stream chunk id \"bad id\""
        );
    }

    #[test]
    fn validates_server_action_reference_payloads() {
        let payload = ServerActionReferencePayload {
            ferrite: SERVER_ACTION_REFERENCE_MARKER.to_owned(),
            version: SERVER_ACTION_REFERENCE_VERSION,
            id: "app/posts/[id]/page.tsx#createPost".to_owned(),
            route_pattern: "/posts/[id]".to_owned(),
            url: "/_ferrite/action".to_owned(),
            bound: BTreeMap::from([("postId".to_owned(), Value::String("abc".to_owned()))]),
        };

        assert!(validate_server_action_reference_payload(&payload).is_ok());

        let mut wrong_marker = payload.clone();
        wrong_marker.ferrite = "server-action".to_owned();
        assert_eq!(
            validate_server_action_reference_payload(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"server-action-reference\""
        );

        let mut wrong_version = payload.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_server_action_reference_payload(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported server action reference version 99; expected 1"
        );

        let mut empty_id = payload.clone();
        empty_id.id.clear();
        assert_eq!(
            validate_server_action_reference_payload(&empty_id)
                .unwrap_err()
                .message(),
            "server action id must be non-empty."
        );

        let mut unsafe_route = payload.clone();
        unsafe_route.route_pattern = "../posts/[id]".to_owned();
        assert_eq!(
            validate_server_action_reference_payload(&unsafe_route)
                .unwrap_err()
                .message(),
            "server action route path must start with `/`."
        );

        let malformed_bound: Value = serde_json::json!({
            "ferrite": SERVER_ACTION_REFERENCE_MARKER,
            "version": SERVER_ACTION_REFERENCE_VERSION,
            "id": "app/posts/[id]/page.tsx#createPost",
            "routePattern": "/posts/[id]",
            "url": "/_ferrite/action",
            "bound": ["not", "an", "object"]
        });
        assert!(serde_json::from_value::<ServerActionReferencePayload>(malformed_bound).is_err());
    }

    #[test]
    fn validates_server_action_requests() {
        let request = ServerActionRequest {
            ferrite: SERVER_ACTION_REQUEST_MARKER.to_owned(),
            version: SERVER_ACTION_REQUEST_VERSION,
            id: "app/posts/[id]/page.tsx#createPost".to_owned(),
            route_path: "/posts/abc".to_owned(),
            form: BTreeMap::from([
                (
                    "title".to_owned(),
                    ServerActionFormValue::String("Hello".to_owned()),
                ),
                (
                    "tag".to_owned(),
                    ServerActionFormValue::List(vec!["rust".to_owned(), "tsx".to_owned()]),
                ),
            ]),
        };

        assert!(validate_server_action_request(&request).is_ok());

        let mut wrong_marker = request.clone();
        wrong_marker.ferrite = "server-action".to_owned();
        assert_eq!(
            validate_server_action_request(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"server-action-request\""
        );

        let mut wrong_version = request.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_server_action_request(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported server action request version 99; expected 1"
        );

        let mut unsafe_route = request.clone();
        unsafe_route.route_path = "posts/abc".to_owned();
        assert_eq!(
            validate_server_action_request(&unsafe_route)
                .unwrap_err()
                .message(),
            "server action route path must start with `/`."
        );

        let mut empty_field_name = request.clone();
        empty_field_name.form.insert(
            String::new(),
            ServerActionFormValue::String("bad".to_owned()),
        );
        assert_eq!(
            validate_server_action_request(&empty_field_name)
                .unwrap_err()
                .message(),
            "server action form field name must be non-empty."
        );
    }

    #[test]
    fn validates_server_action_responses() {
        let ok = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Ok {
                data: serde_json::json!({ "saved": true }),
            },
        };
        assert!(validate_server_action_response(&ok).is_ok());

        let redirect = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Redirect {
                location: "/posts/abc?draft=1#saved".to_owned(),
            },
        };
        assert!(validate_server_action_response(&redirect).is_ok());

        let error = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Error {
                code: Some("POST_CONFLICT".to_owned()),
                message: "Could not save post.".to_owned(),
            },
        };
        assert!(validate_server_action_response(&error).is_ok());

        let legacy_error = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Error {
                code: None,
                message: "Legacy public error.".to_owned(),
            },
        };
        assert!(validate_server_action_response(&legacy_error).is_ok());

        let invalid_error = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Error {
                code: Some("post-conflict".to_owned()),
                message: "Could not save post.".to_owned(),
            },
        };
        assert_eq!(
            validate_server_action_response(&invalid_error)
                .unwrap_err()
                .message(),
            "server action error code must be 1-64 uppercase ASCII letters, digits, or underscores and start with a letter."
        );

        let payload = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Payload {
                payload: ServerPayloadPacket {
                    ferrite: SERVER_PAYLOAD_MARKER.to_owned(),
                    version: SERVER_PAYLOAD_VERSION,
                    shell: CompactNode::Text((0, "updated".to_owned())),
                    client_references: Vec::new(),
                    chunks: Vec::new(),
                },
            },
        };
        assert!(validate_server_action_response(&payload).is_ok());

        let mut wrong_marker = ok.clone();
        wrong_marker.ferrite = "server-action".to_owned();
        assert_eq!(
            validate_server_action_response(&wrong_marker)
                .unwrap_err()
                .message(),
            "expected ferrite marker \"server-action-response\""
        );

        let mut wrong_version = ok.clone();
        wrong_version.version = 99;
        assert_eq!(
            validate_server_action_response(&wrong_version)
                .unwrap_err()
                .message(),
            "unsupported server action response version 99; expected 1"
        );

        let empty_redirect = ServerActionResponse {
            ferrite: SERVER_ACTION_RESPONSE_MARKER.to_owned(),
            version: SERVER_ACTION_RESPONSE_VERSION,
            outcome: ServerActionResponseOutcome::Redirect {
                location: String::new(),
            },
        };
        assert_eq!(
            validate_server_action_response(&empty_redirect)
                .unwrap_err()
                .message(),
            "server action redirect location must be non-empty."
        );

        let ambiguous: Value = serde_json::json!({
            "ferrite": SERVER_ACTION_RESPONSE_MARKER,
            "version": SERVER_ACTION_RESPONSE_VERSION,
            "status": "ok",
            "data": { "saved": true },
            "location": "/posts/abc"
        });
        assert!(serde_json::from_value::<ServerActionResponse>(ambiguous).is_err());
    }

    #[test]
    fn typescript_protocol_mirror_matches_generated_source() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let protocol_ts = manifest_dir.join("../../packages/protocol/src/index.ts");
        let source = fs::read_to_string(&protocol_ts).unwrap_or_else(|error| {
            panic!(
                "failed to read TypeScript protocol mirror at {}: {error}",
                protocol_ts.display()
            )
        });

        assert_eq!(source, typescript_protocol_source());
    }
}
