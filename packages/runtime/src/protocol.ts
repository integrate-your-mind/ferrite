export const RENDER_PACKET_MARKER = "render-packet" as const;
export const RENDER_STREAM_MARKER = "render-stream" as const;
export const RENDER_PACKET_VERSION = 1 as const;

export const COMPACT_TEXT_OPCODE = 0 as const;
export const COMPACT_FRAGMENT_OPCODE = 1 as const;
export const COMPACT_ELEMENT_OPCODE = 2 as const;

export type SerializableProp = string | number | boolean;

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
