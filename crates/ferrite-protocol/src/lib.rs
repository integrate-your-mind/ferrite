use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RENDER_PACKET_MARKER: &str = "render-packet";
pub const RENDER_STREAM_MARKER: &str = "render-stream";
pub const RENDER_PACKET_VERSION: u64 = 1;
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
        r#"
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
"#,
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
    fn typescript_protocol_mirror_matches_generated_source() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let protocol_ts = manifest_dir.join("../../packages/runtime/src/protocol.ts");
        let source = fs::read_to_string(&protocol_ts).unwrap_or_else(|error| {
            panic!(
                "failed to read TypeScript protocol mirror at {}: {error}",
                protocol_ts.display()
            )
        });

        assert_eq!(source, typescript_protocol_source());
    }
}
