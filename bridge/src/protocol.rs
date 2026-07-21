//! Wire envelopes and framing for the broker-to-bridge command protocol.
//!
//! Whitepaper sections 7.2 (framing), 7.3 (envelope), and 7.4 (error model).
//! This module is engine-agnostic so it can be unit-tested without Godot.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Upper bound on a single inbound frame. A frame claiming more than this is
/// treated as a protocol violation rather than allocated, so a malformed or
/// hostile length prefix cannot exhaust memory (whitepaper section 9).
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Broker-to-bridge protocol version. The broker refuses to proceed on a
/// mismatch so a stale library produces a clear message (whitepaper section 7.5).
pub const PROTOCOL_VERSION: u32 = 1;

/// The first frame a bridge writes after accepting a connection, wrapped as
/// `{"hello": Hello}` so the broker can distinguish it from id-correlated
/// responses (whitepaper section 7.5). It is built once on the main thread and
/// handed to the IO thread as bytes, so the listener never calls the engine.
#[derive(Debug, Clone, Serialize)]
pub struct Hello {
    pub role: String,
    pub protocol_version: u32,
    pub bridge_version: String,
    pub engine_version: String,
    pub project_path: String,
    pub pid: u32,
}

impl Hello {
    /// The JSON payload for the hello frame: `{"hello": {...}}`.
    pub fn to_frame_payload(&self) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "hello": self }))
            .unwrap_or_else(|_| b"{\"hello\":null}".to_vec())
    }
}

/// A command sent from the broker to the bridge.
#[derive(Debug, Clone, Deserialize)]
pub struct Command {
    pub id: u64,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

/// The structured error body of a failed response (whitepaper section 7.4).
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// A response from the bridge to the broker, correlated by `id`.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Response { id, ok: true, result: Some(result), error: None }
    }

    pub fn failed(id: u64, error: &BridgeError) -> Self {
        Response { id, ok: false, result: None, error: Some(error.to_body()) }
    }

    /// Build a response from a settled handler result.
    pub fn from_result(id: u64, result: Result<Value, BridgeError>) -> Self {
        match result {
            Ok(value) => Response::ok(id, value),
            Err(error) => Response::failed(id, &error),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        // Serializing a Response of plain JSON values cannot fail in practice;
        // fall back to a minimal hand-built error frame if it somehow does.
        serde_json::to_vec(self).unwrap_or_else(|_| {
            format!(
                "{{\"id\":{},\"ok\":false,\"error\":{{\"code\":\"internal_error\",\"message\":\"response serialization failed\",\"retryable\":false}}}}",
                self.id
            )
            .into_bytes()
        })
    }
}

/// The structured error model. Every handler failure maps to one of these
/// stable codes so the agent can branch on `code` and honour `retryable`.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("no handler is registered for tool '{0}'")]
    UnknownTool(String),
    #[error("bridge is busy; the inbound command queue is full")]
    Busy,
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("{0}")]
    NodeNotFound(String),
    #[error("{0}")]
    InvalidProperty(String),
    #[error("{0}")]
    CallFailed(String),
    #[error("{0}")]
    NotAvailableHeadless(String),
    #[error("{0}")]
    ResourceError(String),
    #[error("{0}")]
    AlreadyExists(String),
    #[error("{0}")]
    NoEditedScene(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl BridgeError {
    pub fn code(&self) -> &'static str {
        match self {
            BridgeError::UnknownTool(_) => "unknown_tool",
            BridgeError::Busy => "busy",
            BridgeError::InvalidArgs(_) => "invalid_args",
            BridgeError::NodeNotFound(_) => "node_not_found",
            BridgeError::InvalidProperty(_) => "invalid_property",
            BridgeError::CallFailed(_) => "call_failed",
            BridgeError::NotAvailableHeadless(_) => "not_available_headless",
            BridgeError::ResourceError(_) => "resource_error",
            BridgeError::AlreadyExists(_) => "already_exists",
            BridgeError::NoEditedScene(_) => "no_edited_scene",
            BridgeError::Internal(_) => "internal_error",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, BridgeError::Busy)
    }

    pub fn to_body(&self) -> ErrorBody {
        ErrorBody { code: self.code().to_string(), message: self.to_string(), retryable: self.retryable() }
    }
}

/// Write one length-prefixed frame: a 4-byte big-endian length then the bytes.
pub fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame exceeds u32 length"))?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Incremental decoder that accumulates bytes and yields complete frames.
///
/// Reads from a non-blocking stream arrive in arbitrary chunks; this buffers
/// partial frames across reads and emits each payload once fully received.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        FrameDecoder { buf: Vec::new() }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Pull the next complete frame, if one is fully buffered.
    ///
    /// Returns `Err` if a length prefix exceeds [`MAX_FRAME_BYTES`], which the
    /// caller treats as a fatal protocol error for the connection.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge(len));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let frame = self.buf[4..4 + len].to_vec();
        self.buf.drain(0..4 + len);
        Ok(Some(frame))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame length {0} exceeds maximum {MAX_FRAME_BYTES}")]
    TooLarge(usize),
}

/// Read exactly one frame from a blocking reader. Used by tests and clients;
/// the non-blocking listener path uses [`FrameDecoder`] instead.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut len_bytes = [0u8; 4];
    reader.read_exact(&mut len_bytes)?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame exceeds maximum size"));
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn error_codes_and_retryable_are_stable() {
        assert_eq!(BridgeError::Busy.code(), "busy");
        assert!(BridgeError::Busy.retryable());
        assert_eq!(BridgeError::UnknownTool("x".into()).code(), "unknown_tool");
        assert!(!BridgeError::UnknownTool("x".into()).retryable());
        assert_eq!(BridgeError::InvalidArgs("bad".into()).code(), "invalid_args");
        assert_eq!(BridgeError::Internal("boom".into()).code(), "internal_error");
        assert_eq!(BridgeError::ResourceError("x".into()).code(), "resource_error");
        assert!(!BridgeError::ResourceError("x".into()).retryable());
        assert_eq!(BridgeError::AlreadyExists("x".into()).code(), "already_exists");
        assert_eq!(BridgeError::NoEditedScene("x".into()).code(), "no_edited_scene");
    }

    #[test]
    fn ok_response_serializes_to_section_7_3_shape() {
        let bytes = Response::ok(42, json!({"previous": 0})).to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["id"], 42);
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["previous"], 0);
        assert!(value.get("error").is_none());
    }

    #[test]
    fn error_response_serializes_to_section_7_4_shape() {
        let bytes = Response::failed(7, &BridgeError::Busy).to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["id"], 7);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "busy");
        assert_eq!(value["error"]["retryable"], true);
        assert!(value.get("result").is_none());
    }

    #[test]
    fn frame_roundtrip_through_writer_and_reader() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"hello").unwrap();
        let mut cursor = std::io::Cursor::new(buffer);
        assert_eq!(read_frame(&mut cursor).unwrap(), b"hello");
    }

    #[test]
    fn decoder_reassembles_frames_split_across_chunks() {
        let mut encoded = Vec::new();
        write_frame(&mut encoded, b"{\"a\":1}").unwrap();
        write_frame(&mut encoded, b"{\"b\":2}").unwrap();

        let mut decoder = FrameDecoder::new();
        // Feed one byte at a time to prove partial-frame reassembly.
        let mut frames = Vec::new();
        for byte in encoded {
            decoder.push(&[byte]);
            while let Some(frame) = decoder.next_frame().unwrap() {
                frames.push(String::from_utf8(frame).unwrap());
            }
        }
        assert_eq!(frames, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
    }

    #[test]
    fn decoder_rejects_oversized_length_prefix() {
        let mut decoder = FrameDecoder::new();
        let bogus_len = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        decoder.push(&bogus_len);
        assert!(matches!(decoder.next_frame(), Err(FrameError::TooLarge(_))));
    }
}
