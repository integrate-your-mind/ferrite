use std::slice;
use std::str;
use std::sync::Mutex;

use ferrite_protocol::{
    ServerPayloadPacket, ServerPayloadStreamChunkFrame, ServerPayloadStreamShellFrame,
    validate_server_payload_packet, validate_server_payload_stream_chunk_frame,
    validate_server_payload_stream_shell_frame,
};

static LAST_ERROR: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[unsafe(no_mangle)]
pub extern "C" fn ferrite_alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
///
/// `ptr` must have been returned by `ferrite_alloc` with the same `len`, and
/// must not have been deallocated already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrite_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }

    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

/// # Safety
///
/// When `len` is non-zero, `ptr` must point to `len` readable bytes in WASM
/// memory. The bytes are read synchronously and are not retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrite_validate_server_payload_json(ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() && len != 0 {
        set_last_error("Ferrite WASM validation received a null payload pointer.");
        return 0;
    }

    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    match validate_server_payload_json_bytes(bytes) {
        Ok(()) => {
            clear_last_error();
            1
        }
        Err(error) => {
            set_last_error(error);
            0
        }
    }
}

/// # Safety
///
/// When `len` is non-zero, `ptr` must point to `len` readable bytes in WASM
/// memory. The bytes are read synchronously and are not retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferrite_validate_server_payload_stream_frame_json(
    ptr: *const u8,
    len: usize,
) -> u32 {
    if ptr.is_null() && len != 0 {
        set_last_error("Ferrite WASM validation received a null stream frame pointer.");
        return 0;
    }

    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    match validate_server_payload_stream_frame_json_bytes(bytes) {
        Ok(()) => {
            clear_last_error();
            1
        }
        Err(error) => {
            set_last_error(error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ferrite_last_error_ptr() -> *const u8 {
    LAST_ERROR
        .lock()
        .expect("last error lock poisoned")
        .as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn ferrite_last_error_len() -> usize {
    LAST_ERROR.lock().expect("last error lock poisoned").len()
}

#[unsafe(no_mangle)]
pub extern "C" fn ferrite_clear_last_error() {
    clear_last_error();
}

pub fn validate_server_payload_json_bytes(bytes: &[u8]) -> Result<(), String> {
    let source = str::from_utf8(bytes)
        .map_err(|error| format!("Ferrite server payload JSON must be UTF-8: {error}"))?;
    let packet: ServerPayloadPacket = serde_json::from_str(source)
        .map_err(|error| format!("invalid server payload JSON: {error}"))?;
    validate_server_payload_packet(&packet).map_err(|error| error.message().to_owned())
}

pub fn validate_server_payload_stream_frame_json_bytes(bytes: &[u8]) -> Result<(), String> {
    let source = str::from_utf8(bytes).map_err(|error| {
        format!("Ferrite server payload stream frame JSON must be UTF-8: {error}")
    })?;
    let value: serde_json::Value = serde_json::from_str(source)
        .map_err(|error| format!("invalid server payload stream frame JSON: {error}"))?;
    let Some(kind) = value.get("kind").and_then(serde_json::Value::as_str) else {
        return Err("server payload stream frame requires a string kind".to_owned());
    };

    match kind {
        "shell" => {
            let frame: ServerPayloadStreamShellFrame =
                serde_json::from_value(value).map_err(|error| {
                    format!("invalid server payload stream shell frame JSON: {error}")
                })?;
            validate_server_payload_stream_shell_frame(&frame)
                .map_err(|error| error.message().to_owned())
        }
        "chunk" => {
            let frame: ServerPayloadStreamChunkFrame =
                serde_json::from_value(value).map_err(|error| {
                    format!("invalid server payload stream chunk frame JSON: {error}")
                })?;
            validate_server_payload_stream_chunk_frame(&frame)
                .map_err(|error| error.message().to_owned())
        }
        other => Err(format!(
            "unsupported server payload stream frame kind {other:?}"
        )),
    }
}

fn set_last_error(error: impl Into<String>) {
    *LAST_ERROR.lock().expect("last error lock poisoned") = error.into().into_bytes();
}

fn clear_last_error() {
    LAST_ERROR.lock().expect("last error lock poisoned").clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_server_payload_json_bytes() {
        let payload = br#"{
          "ferrite": "server-payload",
          "version": 1,
          "shell": [0, "shell"],
          "clientReferences": [],
          "chunks": []
        }"#;

        assert!(validate_server_payload_json_bytes(payload).is_ok());
    }

    #[test]
    fn rejects_malformed_server_payload_json() {
        let error = validate_server_payload_json_bytes(b"{").unwrap_err();

        assert!(error.contains("invalid server payload JSON"));
    }

    #[test]
    fn rejects_invalid_server_payload_json() {
        let payload = br#"{
          "ferrite": "server-payload",
          "version": 1,
          "shell": [0, "shell"],
          "clientReferences": [],
          "chunks": [{ "id": "bad id", "root": [0, "chunk"], "clientReferences": [] }]
        }"#;

        assert_eq!(
            validate_server_payload_json_bytes(payload).unwrap_err(),
            "invalid stream chunk id \"bad id\""
        );
    }

    #[test]
    fn validates_server_payload_stream_frame_json_bytes() {
        let shell = br#"{
          "ferrite": "server-payload-frame",
          "version": 1,
          "kind": "shell",
          "shell": [0, "shell"],
          "clientReferences": []
        }"#;
        let chunk = br#"{
          "ferrite": "server-payload-frame",
          "version": 1,
          "kind": "chunk",
          "chunk": { "id": "s0", "root": [0, "chunk"], "clientReferences": [] }
        }"#;

        assert!(validate_server_payload_stream_frame_json_bytes(shell).is_ok());
        assert!(validate_server_payload_stream_frame_json_bytes(chunk).is_ok());
    }

    #[test]
    fn rejects_invalid_server_payload_stream_frame_json_bytes() {
        let payload = br#"{
          "ferrite": "server-payload-frame",
          "version": 1,
          "kind": "chunk",
          "chunk": { "id": "bad id", "root": [0, "chunk"], "clientReferences": [] }
        }"#;

        assert_eq!(
            validate_server_payload_stream_frame_json_bytes(payload).unwrap_err(),
            "invalid stream chunk id \"bad id\""
        );
    }
}
