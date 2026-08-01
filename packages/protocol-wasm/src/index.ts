import type { ServerPayloadPacket, ServerPayloadStreamFrame } from "@ferrite/protocol";

type FerriteProtocolWasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  ferrite_alloc(len: number): number;
  ferrite_dealloc(ptr: number, len: number): void;
  ferrite_validate_server_payload_json(ptr: number, len: number): number;
  ferrite_validate_server_payload_stream_frame_json(ptr: number, len: number): number;
  ferrite_render_packet_json_to_html(ptr: number, len: number, maxOutputLen: number): number;
  ferrite_render_output_ptr(): number;
  ferrite_render_output_len(): number;
  ferrite_clear_render_output(): void;
  ferrite_last_error_ptr(): number;
  ferrite_last_error_len(): number;
  ferrite_clear_last_error(): void;
};

export type FerriteProtocolWasm = {
  validateServerPayloadJson(json: string): void;
  validateServerPayload(payload: ServerPayloadPacket): ServerPayloadPacket;
  validateServerPayloadStreamFrameJson(json: string): void;
  validateServerPayloadStreamFrame(frame: ServerPayloadStreamFrame): ServerPayloadStreamFrame;
  renderPacketJsonToHtml(json: string, maxOutputBytes?: number): string;
};

const DEFAULT_MAX_RENDER_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function instantiateFerriteProtocolWasm(
  source: BufferSource | WebAssembly.Module | Response | Promise<Response>,
  imports: WebAssembly.Imports = {},
): Promise<FerriteProtocolWasm> {
  const instance = await instantiate(source, imports);
  const exports = validateExports(instance.exports);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function validateServerPayloadJson(json: string): void {
    validateJsonWithWasm(json, exports.ferrite_validate_server_payload_json);
  }

  function validateServerPayloadStreamFrameJson(json: string): void {
    validateJsonWithWasm(json, exports.ferrite_validate_server_payload_stream_frame_json);
  }

  function renderPacketJsonToHtml(
    json: string,
    maxOutputBytes = DEFAULT_MAX_RENDER_OUTPUT_BYTES,
  ): string {
    if (typeof json !== "string") {
      throw new TypeError("Ferrite render packet JSON must be a string.");
    }
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0 ||
      maxOutputBytes > 0xffff_ffff
    ) {
      throw new TypeError("Ferrite render output limit must be a positive 32-bit integer.");
    }

    const bytes = encoder.encode(json);
    const ptr = exports.ferrite_alloc(bytes.length);
    try {
      new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
      if (exports.ferrite_render_packet_json_to_html(ptr, bytes.length, maxOutputBytes) !== 1) {
        throw new TypeError(readLastError(exports, decoder));
      }
      const outputPtr = exports.ferrite_render_output_ptr();
      const outputLen = exports.ferrite_render_output_len();
      return decoder.decode(new Uint8Array(exports.memory.buffer, outputPtr, outputLen));
    } finally {
      exports.ferrite_clear_render_output();
      exports.ferrite_dealloc(ptr, bytes.length);
    }
  }

  function validateJsonWithWasm(
    json: string,
    validate: (ptr: number, len: number) => number,
  ): void {
    const bytes = encoder.encode(json);
    const ptr = exports.ferrite_alloc(bytes.length);
    try {
      new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
      if (validate(ptr, bytes.length) !== 1) {
        throw new TypeError(readLastError(exports, decoder));
      }
    } finally {
      exports.ferrite_dealloc(ptr, bytes.length);
    }
  }

  return {
    validateServerPayloadJson,
    validateServerPayload(payload) {
      validateServerPayloadJson(JSON.stringify(payload));
      return payload;
    },
    validateServerPayloadStreamFrameJson,
    validateServerPayloadStreamFrame(frame) {
      validateServerPayloadStreamFrameJson(JSON.stringify(frame));
      return frame;
    },
    renderPacketJsonToHtml,
  };
}

async function instantiate(
  source: BufferSource | WebAssembly.Module | Response | Promise<Response>,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> {
  const resolved = await source;
  if (resolved instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(resolved, imports);
  }
  if (isResponse(resolved)) {
    if (WebAssembly.instantiateStreaming) {
      return (await WebAssembly.instantiateStreaming(resolved, imports)).instance;
    }
    return instantiate(await resolved.arrayBuffer(), imports);
  }

  return (await WebAssembly.instantiate(resolved, imports)).instance;
}

function validateExports(exports: WebAssembly.Exports): FerriteProtocolWasmExports {
  const candidate = exports as Partial<FerriteProtocolWasmExports>;
  for (const name of [
    "memory",
    "ferrite_alloc",
    "ferrite_dealloc",
    "ferrite_validate_server_payload_json",
    "ferrite_validate_server_payload_stream_frame_json",
    "ferrite_render_packet_json_to_html",
    "ferrite_render_output_ptr",
    "ferrite_render_output_len",
    "ferrite_clear_render_output",
    "ferrite_last_error_ptr",
    "ferrite_last_error_len",
    "ferrite_clear_last_error",
  ] as const) {
    if (!(name in candidate)) {
      throw new TypeError(`Ferrite protocol WASM export ${name} is missing.`);
    }
  }
  if (!(candidate.memory instanceof WebAssembly.Memory)) {
    throw new TypeError("Ferrite protocol WASM export memory must be a WebAssembly.Memory.");
  }

  return candidate as FerriteProtocolWasmExports;
}

function readLastError(exports: FerriteProtocolWasmExports, decoder: TextDecoder): string {
  const ptr = exports.ferrite_last_error_ptr();
  const len = exports.ferrite_last_error_len();
  try {
    if (len === 0) {
      return "Ferrite protocol WASM validation failed.";
    }
    return decoder.decode(new Uint8Array(exports.memory.buffer, ptr, len));
  } finally {
    exports.ferrite_clear_last_error();
  }
}

function isResponse(value: unknown): value is Response {
  return typeof Response !== "undefined" && value instanceof Response;
}
