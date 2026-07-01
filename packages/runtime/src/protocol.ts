export const RENDER_PACKET_MARKER = "render-packet" as const;
export const RENDER_STREAM_MARKER = "render-stream" as const;
export const RENDER_PACKET_VERSION = 1 as const;
export const CLIENT_REFERENCE_MARKER = "client-reference" as const;
export const CLIENT_REFERENCE_VERSION = 1 as const;
export const SERVER_PAYLOAD_MARKER = "server-payload" as const;
export const SERVER_PAYLOAD_VERSION = 1 as const;
export const SERVER_PAYLOAD_STREAM_FRAME_MARKER = "server-payload-frame" as const;
export const SERVER_PAYLOAD_STREAM_FRAME_VERSION = 1 as const;

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
