use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const RENDER_PACKET_MARKER: &str = "render-packet";
pub const RENDER_STREAM_MARKER: &str = "render-stream";
pub const CLIENT_REFERENCE_MARKER: &str = "client-reference";
pub const RENDER_PACKET_VERSION: u64 = 1;
pub const CLIENT_REFERENCE_VERSION: u64 = 1;
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
