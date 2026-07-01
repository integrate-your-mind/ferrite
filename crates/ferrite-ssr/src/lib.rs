use std::collections::BTreeMap;
use std::fmt;

use ferrite_core::{AttributeValue, Node, element, fragment, render_to_html, text};
pub use ferrite_protocol::{
    COMPACT_ELEMENT_OPCODE, COMPACT_FRAGMENT_OPCODE, COMPACT_TEXT_OPCODE, CompactNode,
    RENDER_PACKET_MARKER, RENDER_PACKET_VERSION, RENDER_STREAM_MARKER, RenderPacket,
    RenderStreamChunk, RenderStreamPacket, SERVER_PAYLOAD_MARKER, SerializableProp,
    ServerPayloadPacket, ferrite_marker, looks_like_ferrite_payload, validate_chunk_id,
    validate_packet, validate_server_payload_packet, validate_stream_packet,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug)]
pub enum SsrError {
    Core(ferrite_core::CoreError),
    Json(serde_json::Error),
    InvalidRenderPacket(String),
}

impl fmt::Display for SsrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SsrError::Core(error) => write!(f, "{error}"),
            SsrError::Json(error) => write!(f, "{error}"),
            SsrError::InvalidRenderPacket(message) => write!(f, "invalid render packet: {message}"),
        }
    }
}

impl std::error::Error for SsrError {}

impl From<ferrite_core::CoreError> for SsrError {
    fn from(error: ferrite_core::CoreError) -> Self {
        SsrError::Core(error)
    }
}

impl From<serde_json::Error> for SsrError {
    fn from(error: serde_json::Error) -> Self {
        SsrError::Json(error)
    }
}

impl From<ferrite_protocol::ProtocolError> for SsrError {
    fn from(error: ferrite_protocol::ProtocolError) -> Self {
        SsrError::InvalidRenderPacket(error.message().to_owned())
    }
}

pub type Result<T> = std::result::Result<T, SsrError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SerializableNode {
    Element {
        tag: String,
        #[serde(default)]
        props: BTreeMap<String, SerializableProp>,
        #[serde(default)]
        children: Vec<SerializableNode>,
    },
    Text {
        value: String,
    },
    Fragment {
        #[serde(default)]
        children: Vec<SerializableNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderStreamParts {
    pub shell: String,
    pub chunks: Vec<RenderedStreamChunk>,
}

impl RenderStreamParts {
    pub fn to_html(&self) -> String {
        let mut html = self.shell.clone();
        for chunk in &self.chunks {
            html.push_str(&chunk.html);
        }
        html
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedStreamChunk {
    pub id: String,
    pub html: String,
}

pub fn render_json_to_html(input: &str) -> Result<String> {
    let value: Value = serde_json::from_str(input)?;

    if let Some(marker) = ferrite_marker(&value)? {
        return match marker {
            RENDER_PACKET_MARKER => {
                let packet: RenderPacket = serde_json::from_value(value)?;
                render_packet_to_html(&packet)
            }
            RENDER_STREAM_MARKER => {
                let packet: RenderStreamPacket = serde_json::from_value(value)?;
                Ok(render_stream_packet_to_parts(&packet)?.to_html())
            }
            SERVER_PAYLOAD_MARKER => {
                let packet: ServerPayloadPacket = serde_json::from_value(value)?;
                Ok(render_server_payload_packet_to_parts(&packet)?.to_html())
            }
            _ => Err(SsrError::InvalidRenderPacket(format!(
                "unsupported ferrite marker \"{marker}\""
            ))),
        };
    }

    if looks_like_ferrite_payload(&value) {
        return Err(SsrError::InvalidRenderPacket(format!(
            "expected ferrite marker \"{RENDER_PACKET_MARKER}\", \"{RENDER_STREAM_MARKER}\", or \"{SERVER_PAYLOAD_MARKER}\""
        )));
    }

    let node: SerializableNode = serde_json::from_value(value)?;
    render_serializable_to_html(&node)
}

pub fn render_serializable_to_html(node: &SerializableNode) -> Result<String> {
    let core_node = to_core_node(node)?;
    Ok(render_to_html(&core_node)?)
}

pub fn render_packet_to_html(packet: &RenderPacket) -> Result<String> {
    validate_packet(packet)?;
    let core_node = compact_to_core_node(&packet.root)?;
    Ok(render_to_html(&core_node)?)
}

pub fn render_stream_json_to_parts(input: &str) -> Result<RenderStreamParts> {
    let value: Value = serde_json::from_str(input)?;
    let marker = ferrite_marker(&value)?;
    if marker != Some(RENDER_STREAM_MARKER) {
        return Err(SsrError::InvalidRenderPacket(format!(
            "expected ferrite marker \"{RENDER_STREAM_MARKER}\""
        )));
    }

    let packet: RenderStreamPacket = serde_json::from_value(value)?;
    render_stream_packet_to_parts(&packet)
}

pub fn render_server_payload_json_to_parts(input: &str) -> Result<RenderStreamParts> {
    let value: Value = serde_json::from_str(input)?;
    let marker = ferrite_marker(&value)?;
    if marker != Some(SERVER_PAYLOAD_MARKER) {
        return Err(SsrError::InvalidRenderPacket(format!(
            "expected ferrite marker \"{SERVER_PAYLOAD_MARKER}\""
        )));
    }

    let packet: ServerPayloadPacket = serde_json::from_value(value)?;
    render_server_payload_packet_to_parts(&packet)
}

pub fn render_stream_packet_to_parts(packet: &RenderStreamPacket) -> Result<RenderStreamParts> {
    validate_stream_packet(packet)?;
    let shell = render_to_html(&compact_to_core_node(&packet.shell)?)?;
    let mut chunks = Vec::with_capacity(packet.chunks.len());

    for chunk in &packet.chunks {
        validate_chunk_id(&chunk.id)?;
        let html = render_to_html(&compact_to_core_node(&chunk.root)?)?;
        chunks.push(RenderedStreamChunk {
            id: chunk.id.clone(),
            html: render_stream_chunk_html(&chunk.id, &html),
        });
    }

    Ok(RenderStreamParts { shell, chunks })
}

pub fn render_server_payload_packet_to_parts(
    packet: &ServerPayloadPacket,
) -> Result<RenderStreamParts> {
    validate_server_payload_packet(packet)?;
    let shell = render_to_html(&compact_to_core_node(&packet.shell)?)?;
    let mut chunks = Vec::with_capacity(packet.chunks.len());

    for chunk in &packet.chunks {
        let html = render_to_html(&compact_to_core_node(&chunk.root)?)?;
        chunks.push(RenderedStreamChunk {
            id: chunk.id.clone(),
            html: render_stream_chunk_html(&chunk.id, &html),
        });
    }

    Ok(RenderStreamParts { shell, chunks })
}

fn render_stream_chunk_html(id: &str, html: &str) -> String {
    format!(
        "<template data-ferrite-stream-chunk=\"{id}\">{html}</template><script data-ferrite-stream-script=\"{id}\">(()=>{{const t=document.querySelector('template[data-ferrite-stream-chunk=\"{id}\"]');const b=document.querySelector('[data-ferrite-suspense-boundary=\"{id}\"]');if(t&&b){{b.replaceWith(t.content.cloneNode(true));t.remove();}}}})();</script>"
    )
}

fn to_core_node(node: &SerializableNode) -> Result<Node> {
    match node {
        SerializableNode::Text { value } => Ok(text(value)),
        SerializableNode::Fragment { children } => {
            let children = children
                .iter()
                .map(to_core_node)
                .collect::<Result<Vec<_>>>()?;
            Ok(fragment(children))
        }
        SerializableNode::Element {
            tag,
            props,
            children,
        } => {
            let props = props
                .iter()
                .map(|(name, value)| (name.clone(), to_attribute_value(value)))
                .collect::<Vec<_>>();
            let children = children
                .iter()
                .map(to_core_node)
                .collect::<Result<Vec<_>>>()?;
            Ok(element(tag, props, children)?)
        }
    }
}

fn compact_to_core_node(node: &CompactNode) -> Result<Node> {
    match node {
        CompactNode::Text((opcode, value)) => {
            validate_opcode(*opcode, COMPACT_TEXT_OPCODE, "text")?;
            Ok(text(value))
        }
        CompactNode::Fragment((opcode, children)) => {
            validate_opcode(*opcode, COMPACT_FRAGMENT_OPCODE, "fragment")?;
            let children = children
                .iter()
                .map(compact_to_core_node)
                .collect::<Result<Vec<_>>>()?;
            Ok(fragment(children))
        }
        CompactNode::Element((opcode, tag, props, children)) => {
            validate_opcode(*opcode, COMPACT_ELEMENT_OPCODE, "element")?;
            let props = props
                .iter()
                .map(|(name, value)| (name.clone(), to_attribute_value(value)))
                .collect::<Vec<_>>();
            let children = children
                .iter()
                .map(compact_to_core_node)
                .collect::<Result<Vec<_>>>()?;
            Ok(element(tag, props, children)?)
        }
    }
}

fn validate_opcode(actual: u8, expected: u8, node_kind: &str) -> Result<()> {
    if actual == expected {
        return Ok(());
    }

    Err(SsrError::InvalidRenderPacket(format!(
        "{node_kind} node used opcode {actual}; expected {expected}"
    )))
}

fn to_attribute_value(value: &SerializableProp) -> AttributeValue {
    match value {
        SerializableProp::String(value) => AttributeValue::String(value.clone()),
        SerializableProp::Bool(value) => AttributeValue::Bool(*value),
        SerializableProp::Number(value) => AttributeValue::Number(*value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_serialized_element_tree() {
        let input = r#"
        {
          "kind": "element",
          "tag": "main",
          "props": { "class": "shell", "data-count": 2 },
          "children": [
            { "kind": "element", "tag": "h1", "children": [{ "kind": "text", "value": "Ferrite" }] },
            { "kind": "text", "value": " & Rust" }
          ]
        }
        "#;

        assert_eq!(
            render_json_to_html(input).unwrap(),
            "<main class=\"shell\" data-count=\"2\"><h1>Ferrite</h1> &amp; Rust</main>"
        );
    }

    #[test]
    fn renders_compact_render_packet() {
        let input = r#"
        {
          "ferrite": "render-packet",
          "version": 1,
          "root": [
            2,
            "main",
            { "class": "shell", "data-count": 2 },
            [
              [2, "h1", {}, [[0, "Ferrite"]]],
              [0, " & Rust"]
            ]
          ]
        }
        "#;

        assert_eq!(
            render_json_to_html(input).unwrap(),
            "<main class=\"shell\" data-count=\"2\"><h1>Ferrite</h1> &amp; Rust</main>"
        );
    }

    #[test]
    fn rejects_invalid_render_packet_marker() {
        let input = r#"{ "ferrite": "other", "version": 1, "root": [0, "Bad"] }"#;
        let error = render_json_to_html(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::InvalidRenderPacket(message)
                if message.contains("unsupported ferrite marker")
        ));
    }

    #[test]
    fn rejects_unsupported_render_packet_version() {
        let input = r#"{ "ferrite": "render-packet", "version": 2, "root": [0, "Bad"] }"#;
        let error = render_json_to_html(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::InvalidRenderPacket(message)
                if message.contains("unsupported version 2")
        ));
    }

    #[test]
    fn rejects_invalid_compact_node_opcode() {
        let input = r#"{ "ferrite": "render-packet", "version": 1, "root": [9, "Bad"] }"#;
        let error = render_json_to_html(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::InvalidRenderPacket(message)
                if message.contains("text node used opcode 9")
        ));
    }

    #[test]
    fn renders_stream_packet_to_ordered_parts() {
        let input = r#"
        {
          "ferrite": "render-stream",
          "version": 1,
          "shell": [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading"]]],
          "chunks": [
            { "id": "s0", "root": [2, "strong", {}, [[0, "Loaded"]] ] }
          ]
        }
        "#;

        let parts = render_stream_json_to_parts(input).unwrap();

        assert_eq!(
            parts.shell,
            "<div data-ferrite-suspense-boundary=\"s0\">Loading</div>"
        );
        assert_eq!(parts.chunks.len(), 1);
        assert_eq!(parts.chunks[0].id, "s0");
        assert!(
            parts.chunks[0]
                .html
                .contains("data-ferrite-stream-chunk=\"s0\"")
        );
        assert!(parts.chunks[0].html.contains("<strong>Loaded</strong>"));
    }

    #[test]
    fn renders_stream_packet_to_concatenated_html() {
        let input = r#"
        {
          "ferrite": "render-stream",
          "version": 1,
          "shell": [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading"]]],
          "chunks": [
            { "id": "s0", "root": [2, "strong", {}, [[0, "Loaded"]] ] }
          ]
        }
        "#;

        let html = render_json_to_html(input).unwrap();

        assert!(html.starts_with("<div data-ferrite-suspense-boundary=\"s0\">Loading</div>"));
        assert!(html.contains(
            "<template data-ferrite-stream-chunk=\"s0\"><strong>Loaded</strong></template>"
        ));
    }

    #[test]
    fn renders_server_payload_to_concatenated_html() {
        let input = r#"
        {
          "ferrite": "server-payload",
          "version": 1,
          "shell": [
            2,
            "span",
            {
              "data-ferrite-client-reference": "app/Button.tsx#default",
              "data-ferrite-client-payload": "{\"ferrite\":\"client-reference\",\"version\":1,\"id\":\"app/Button.tsx#default\",\"module\":\"app/Button.tsx\",\"exportName\":\"default\",\"props\":{\"id\":\"alpha\"}}"
            },
            [[0, "Like alpha: 0"]]
          ],
          "clientReferences": [
            {
              "ferrite": "client-reference",
              "version": 1,
              "id": "app/Button.tsx#default",
              "module": "app/Button.tsx",
              "exportName": "default",
              "props": { "id": "alpha" }
            }
          ],
          "chunks": [
            {
              "id": "s0",
              "root": [2, "strong", {}, [[0, "Loaded"]] ],
              "clientReferences": []
            }
          ]
        }
        "#;

        let html = render_json_to_html(input).unwrap();

        assert!(html.starts_with("<span data-ferrite-client-payload="));
        assert!(html.contains("data-ferrite-client-reference=\"app/Button.tsx#default\""));
        assert!(html.contains(
            "<template data-ferrite-stream-chunk=\"s0\"><strong>Loaded</strong></template>"
        ));
    }

    #[test]
    fn rejects_invalid_stream_chunk_ids() {
        let input = r#"
        {
          "ferrite": "render-stream",
          "version": 1,
          "shell": [0, "Loading"],
          "chunks": [
            { "id": "bad id", "root": [0, "Loaded"] }
          ]
        }
        "#;
        let error = render_stream_json_to_parts(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::InvalidRenderPacket(message)
                if message.contains("invalid stream chunk id")
        ));
    }

    #[test]
    fn rejects_invalid_server_payload_client_references() {
        let input = r#"
        {
          "ferrite": "server-payload",
          "version": 1,
          "shell": [0, "Loading"],
          "clientReferences": [
            {
              "ferrite": "client-reference",
              "version": 1,
              "id": "app/Button.tsx#Other",
              "module": "app/Button.tsx",
              "exportName": "default",
              "props": {}
            }
          ],
          "chunks": []
        }
        "#;
        let error = render_json_to_html(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::InvalidRenderPacket(message)
                if message.contains("client reference id must equal")
        ));
    }

    #[test]
    fn rejects_invalid_serialized_html() {
        let input = r#"{ "kind": "element", "tag": "bad tag" }"#;
        let error = render_json_to_html(input).unwrap_err();

        assert!(matches!(
            error,
            SsrError::Core(ferrite_core::CoreError::InvalidTagName(_))
        ));
    }

    #[test]
    fn renders_fragments() {
        let input = r#"
        {
          "kind": "fragment",
          "children": [
            { "kind": "text", "value": "A" },
            { "kind": "text", "value": "B" }
          ]
        }
        "#;

        assert_eq!(render_json_to_html(input).unwrap(), "AB");
    }
}
