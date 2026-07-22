//! Runtime networking (whitepaper section 8 "Networking", phase 9): HTTP
//! requests, a WebSocket client, and ENet multiplayer lifecycle with RPC.
//!
//! Everything goes through engine-side objects, not Rust networking crates:
//! an `HTTPRequest` node completes through its `request_completed` signal into
//! a native sink polled by a `PendingOp` (the `gd_game_eval` pattern), and
//! `WebSocketPeer` is a poll-per-frame API serviced from the runtime node's
//! `_process` via [`service_frame`]. ENet peers are installed on the tree's
//! MultiplayerAPI, which the SceneTree polls itself.
//!
//! These tools are eval-class (section 9): the broker registers them only when
//! `--disable-eval` is absent. Failures map to the retryable `network_error`.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use godot::classes::{
    http_client, ENetMultiplayerPeer, HttpRequest, MultiplayerApi, MultiplayerPeer, RefCounted, WebSocketPeer,
};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::base64;
use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::{
    optional_f64, optional_str, optional_u64, require_str, resolve_node, scene_root, scene_tree,
};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, variant_to_json};

const HTTP_DEFAULT_TIMEOUT_S: f64 = 30.0;
const HTTP_MAX_TIMEOUT_S: f64 = 120.0;
const HTTP_DEFAULT_MAX_BODY: usize = 64 * 1024;
const HTTP_DEADLINE_FRAMES: u64 = 60 * 150;
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const WS_RECV_DEFAULT_TIMEOUT_S: f64 = 10.0;
const WS_RECV_MAX_TIMEOUT_S: f64 = 60.0;
const WS_MAX_CONNECTIONS: usize = 8;
const WS_INBOX_CAP: usize = 256;

/// Native receiver for `request_completed`. Main thread only.
#[derive(GodotClass)]
#[class(base = RefCounted, init)]
pub struct ConduitHttpSink {
    base: Base<RefCounted>,
    done: bool,
    result: i64,
    response_code: i64,
    headers: PackedStringArray,
    body: PackedByteArray,
}

#[godot_api]
impl ConduitHttpSink {
    #[func]
    fn on_completed(&mut self, result: i64, response_code: i64, headers: PackedStringArray, body: PackedByteArray) {
        self.result = result;
        self.response_code = response_code;
        self.headers = headers;
        self.body = body;
        self.done = true;
    }
}

struct PreparedRequest {
    url: String,
    method: http_client::Method,
    header_lines: Vec<String>,
    body: String,
    timeout_s: f64,
    max_body: usize,
}

pub fn http_request(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<PreparedRequest, BridgeError> = (|| {
        let url = require_str(args, "url")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(BridgeError::InvalidArgs("'url' must start with http:// or https://".into()));
        }
        let method = parse_http_method(optional_str(args, "method").as_deref().unwrap_or("GET"))?;
        let header_lines = parse_headers(args)?;
        let body = optional_str(args, "body").unwrap_or_default();
        let timeout_s = optional_f64(args, "timeout_s").unwrap_or(HTTP_DEFAULT_TIMEOUT_S).clamp(1.0, HTTP_MAX_TIMEOUT_S);
        let max_body = optional_u64(args, "max_body_bytes").unwrap_or(HTTP_DEFAULT_MAX_BODY as u64) as usize;
        Ok(PreparedRequest { url, method, header_lines, body, timeout_s, max_body })
    })();
    let request = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    let root = match scene_root() {
        Ok(root) => root,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };

    let mut headers = PackedStringArray::new();
    for line in &request.header_lines {
        headers.push(&GString::from(line.as_str()));
    }

    let mut node = HttpRequest::new_alloc();
    let mut root = root;
    root.add_child(&node);
    node.set_timeout(request.timeout_s);

    let sink = ConduitHttpSink::new_gd();
    node.connect("request_completed", &Callable::from_object_method(&sink, "on_completed"));

    let err = node
        .request_ex(request.url.as_str())
        .custom_headers(&headers)
        .method(request.method)
        .request_data(request.body.as_str())
        .done();
    if err != godot::global::Error::OK {
        node.queue_free();
        return HandlerOutcome::Done(Err(BridgeError::NetworkError(format!(
            "http request could not start: {err:?}"
        ))));
    }

    HandlerOutcome::Pending(Box::new(HttpPending {
        node,
        sink,
        url: request.url,
        max_body: request.max_body,
        deadline_frame: ctx.frame_index.saturating_add(HTTP_DEADLINE_FRAMES),
    }))
}

fn parse_http_method(name: &str) -> Result<http_client::Method, BridgeError> {
    match name.to_ascii_uppercase().as_str() {
        "GET" => Ok(http_client::Method::GET),
        "HEAD" => Ok(http_client::Method::HEAD),
        "POST" => Ok(http_client::Method::POST),
        "PUT" => Ok(http_client::Method::PUT),
        "DELETE" => Ok(http_client::Method::DELETE),
        "OPTIONS" => Ok(http_client::Method::OPTIONS),
        "PATCH" => Ok(http_client::Method::PATCH),
        other => Err(BridgeError::InvalidArgs(format!(
            "'method' must be GET, HEAD, POST, PUT, DELETE, OPTIONS, or PATCH; got '{other}'"
        ))),
    }
}

/// Headers as `{"Name": "value"}` or `["Name: value", ...]`. Engine-free so
/// validation is unit-testable; the caller packs the lines for the engine.
fn parse_headers(args: &Value) -> Result<Vec<String>, BridgeError> {
    let mut lines = Vec::new();
    match args.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (name, value) in map {
                let text = value
                    .as_str()
                    .ok_or_else(|| BridgeError::InvalidArgs(format!("header '{name}' must be a string")))?;
                lines.push(format!("{name}: {text}"));
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let line = item
                    .as_str()
                    .ok_or_else(|| BridgeError::InvalidArgs("'headers' array entries must be strings".into()))?;
                lines.push(line.to_string());
            }
        }
        Some(_) => return Err(BridgeError::InvalidArgs("'headers' must be an object map or an array of strings".into())),
    }
    Ok(lines)
}

struct HttpPending {
    node: Gd<HttpRequest>,
    sink: Gd<ConduitHttpSink>,
    url: String,
    max_body: usize,
    deadline_frame: u64,
}

impl PendingOp for HttpPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if !self.sink.bind().done {
            if ctx.frame_index >= self.deadline_frame {
                if self.node.is_instance_valid() {
                    self.node.queue_free();
                }
                return Some(Err(BridgeError::NetworkError(format!("http request to {} never completed", self.url))));
            }
            return None;
        }

        let (result, response_code, headers, body) = {
            let sink = self.sink.bind();
            (sink.result, sink.response_code, sink.headers.clone(), sink.body.clone())
        };
        if self.node.is_instance_valid() {
            self.node.queue_free();
        }

        // Result codes are HTTPRequest.Result: 0 is success; everything else is
        // a transport-level failure (timeout, connection error, TLS handshake).
        if result != 0 {
            return Some(Err(BridgeError::NetworkError(format!(
                "http request to {} failed with result code {result} (HTTPRequest.Result)",
                self.url
            ))));
        }

        let bytes = body.to_vec();
        let truncated = bytes.len() > self.max_body;
        let kept = &bytes[..bytes.len().min(self.max_body)];
        let text = String::from_utf8_lossy(kept).to_string();
        Some(Ok(json!({
            "url": self.url,
            "response_code": response_code,
            "headers": headers.as_slice().iter().map(|h| h.to_string()).collect::<Vec<String>>(),
            "body": text,
            "body_bytes": bytes.len(),
            "truncated": truncated,
        })))
    }
}

struct WsConn {
    peer: Gd<WebSocketPeer>,
    inbox: VecDeque<Value>,
    dropped: u64,
}

thread_local! {
    static WS_CONNS: RefCell<HashMap<u64, WsConn>> = RefCell::new(HashMap::new());
    static WS_NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
}

/// Poll every open WebSocket peer and drain arrived packets into bounded
/// inboxes. Called once per frame from the game bridge's `_process`;
/// `WebSocketPeer` makes no progress without it.
pub fn service_frame() {
    WS_CONNS.with(|conns| {
        for conn in conns.borrow_mut().values_mut() {
            conn.peer.poll();
            while conn.peer.get_available_packet_count() > 0 {
                let packet = conn.peer.get_packet();
                let message = if conn.peer.was_string_packet() {
                    json!({ "text": String::from_utf8_lossy(packet.as_slice()).to_string() })
                } else {
                    json!({ "base64": base64::encode(packet.as_slice()) })
                };
                conn.inbox.push_back(message);
                if conn.inbox.len() > WS_INBOX_CAP {
                    conn.inbox.pop_front();
                    conn.dropped += 1;
                }
            }
        }
    });
}

pub fn websocket(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let op = match require_str(args, "op") {
        Ok(op) => op,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    match op.as_str() {
        "connect" => ws_connect(args),
        "send" => HandlerOutcome::Done(ws_send(args)),
        "recv" => ws_recv(args),
        "close" => HandlerOutcome::Done(ws_close(args)),
        "status" => HandlerOutcome::Done(ws_status()),
        other => HandlerOutcome::Done(Err(BridgeError::InvalidArgs(format!(
            "'op' must be connect, send, recv, close, or status; got '{other}'"
        )))),
    }
}

fn ws_connect(args: &Value) -> HandlerOutcome {
    let url = match require_str(args, "url") {
        Ok(url) => url,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return HandlerOutcome::Done(Err(BridgeError::InvalidArgs("'url' must start with ws:// or wss://".into())));
    }
    let at_capacity = WS_CONNS.with(|conns| conns.borrow().len() >= WS_MAX_CONNECTIONS);
    if at_capacity {
        return HandlerOutcome::Done(Err(BridgeError::NetworkError(format!(
            "too many open websocket connections (max {WS_MAX_CONNECTIONS}); close one first"
        ))));
    }

    let mut peer = WebSocketPeer::new_gd();
    let err = peer.connect_to_url(url.as_str());
    if err != godot::global::Error::OK {
        return HandlerOutcome::Done(Err(BridgeError::NetworkError(format!(
            "websocket connect to {url} could not start: {err:?}"
        ))));
    }

    let id = WS_NEXT_ID.with(|next| {
        let mut next = next.borrow_mut();
        let id = *next;
        *next += 1;
        id
    });
    WS_CONNS.with(|conns| {
        conns.borrow_mut().insert(id, WsConn { peer, inbox: VecDeque::new(), dropped: 0 });
    });

    HandlerOutcome::Pending(Box::new(WsConnectPending { id, url, deadline: Instant::now() + WS_CONNECT_TIMEOUT }))
}

struct WsConnectPending {
    id: u64,
    url: String,
    deadline: Instant,
}

impl PendingOp for WsConnectPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let state = WS_CONNS.with(|conns| conns.borrow().get(&self.id).map(|conn| conn.peer.get_ready_state()));
        let Some(state) = state else {
            return Some(Err(BridgeError::NetworkError("websocket connection was closed while connecting".into())));
        };
        match state {
            godot::classes::web_socket_peer::State::OPEN => {
                Some(Ok(json!({ "id": self.id, "state": "open", "url": self.url })))
            }
            godot::classes::web_socket_peer::State::CLOSED => {
                let detail = WS_CONNS.with(|conns| {
                    conns
                        .borrow()
                        .get(&self.id)
                        .map(|conn| (conn.peer.get_close_code(), conn.peer.get_close_reason().to_string()))
                });
                WS_CONNS.with(|conns| conns.borrow_mut().remove(&self.id));
                let (code, reason) = detail.unwrap_or((-1, String::new()));
                Some(Err(BridgeError::NetworkError(format!(
                    "websocket connect to {} failed (close code {code}, reason '{reason}')",
                    self.url
                ))))
            }
            _ if Instant::now() >= self.deadline => {
                WS_CONNS.with(|conns| conns.borrow_mut().remove(&self.id));
                Some(Err(BridgeError::NetworkError(format!("websocket connect to {} timed out", self.url))))
            }
            _ => None,
        }
    }
}

fn ws_require_id(args: &Value) -> Result<u64, BridgeError> {
    optional_u64(args, "id").ok_or_else(|| BridgeError::InvalidArgs("'id' (from op=connect) is required".into()))
}

fn ws_send(args: &Value) -> Result<Value, BridgeError> {
    let id = ws_require_id(args)?;
    let text = require_str(args, "text")?;
    WS_CONNS.with(|conns| {
        let mut conns = conns.borrow_mut();
        let conn = conns
            .get_mut(&id)
            .ok_or_else(|| BridgeError::NetworkError(format!("no open websocket connection with id {id}")))?;
        if conn.peer.get_ready_state() != godot::classes::web_socket_peer::State::OPEN {
            return Err(BridgeError::NetworkError(format!("websocket {id} is not open")));
        }
        let err = conn.peer.send_text(text.as_str());
        if err != godot::global::Error::OK {
            return Err(BridgeError::NetworkError(format!("websocket send failed: {err:?}")));
        }
        Ok(json!({ "id": id, "sent": true }))
    })
}

fn ws_recv(args: &Value) -> HandlerOutcome {
    let id = match ws_require_id(args) {
        Ok(id) => id,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    let timeout_s = optional_f64(args, "timeout_s").unwrap_or(WS_RECV_DEFAULT_TIMEOUT_S).clamp(0.0, WS_RECV_MAX_TIMEOUT_S);
    HandlerOutcome::Pending(Box::new(WsRecvPending { id, deadline: Instant::now() + Duration::from_secs_f64(timeout_s) }))
}

struct WsRecvPending {
    id: u64,
    deadline: Instant,
}

impl PendingOp for WsRecvPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let popped = WS_CONNS.with(|conns| {
            let mut conns = conns.borrow_mut();
            match conns.get_mut(&self.id) {
                None => Err(BridgeError::NetworkError(format!("no open websocket connection with id {}", self.id))),
                Some(conn) => Ok(conn.inbox.pop_front()),
            }
        });
        match popped {
            Err(err) => Some(Err(err)),
            Ok(Some(message)) => Some(Ok(json!({ "id": self.id, "message": message, "timed_out": false }))),
            Ok(None) => {
                let closed = WS_CONNS.with(|conns| {
                    conns
                        .borrow()
                        .get(&self.id)
                        .is_some_and(|conn| conn.peer.get_ready_state() == godot::classes::web_socket_peer::State::CLOSED)
                });
                if closed {
                    return Some(Err(BridgeError::NetworkError(format!(
                        "websocket {} closed with no pending messages",
                        self.id
                    ))));
                }
                if Instant::now() >= self.deadline {
                    return Some(Ok(json!({ "id": self.id, "message": Value::Null, "timed_out": true })));
                }
                None
            }
        }
    }
}

fn ws_close(args: &Value) -> Result<Value, BridgeError> {
    let id = ws_require_id(args)?;
    WS_CONNS.with(|conns| {
        let mut conns = conns.borrow_mut();
        let mut conn = conns
            .remove(&id)
            .ok_or_else(|| BridgeError::NetworkError(format!("no open websocket connection with id {id}")))?;
        conn.peer.close();
        Ok(json!({ "id": id, "closed": true }))
    })
}

fn ws_status() -> Result<Value, BridgeError> {
    let connections = WS_CONNS.with(|conns| {
        conns
            .borrow()
            .iter()
            .map(|(id, conn)| {
                json!({
                    "id": id,
                    "state": format!("{:?}", conn.peer.get_ready_state()),
                    "pending_messages": conn.inbox.len(),
                    "dropped_messages": conn.dropped,
                })
            })
            .collect::<Vec<Value>>()
    });
    Ok(json!({ "connections": connections }))
}

pub fn multiplayer(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "create_server" => mp_create_server(args),
            "create_client" => mp_create_client(args),
            "disconnect" => mp_disconnect(),
            "status" => mp_status(),
            "rpc" => mp_rpc(args),
            "rpc_config" => mp_rpc_config(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "'op' must be create_server, create_client, disconnect, status, rpc, or rpc_config; got '{other}'"
            ))),
        }
    })())
}

fn multiplayer_api() -> Result<Gd<MultiplayerApi>, BridgeError> {
    scene_tree()?
        .get_multiplayer()
        .ok_or_else(|| BridgeError::Internal("scene tree has no MultiplayerAPI".into()))
}

fn require_port(args: &Value) -> Result<i32, BridgeError> {
    let port = optional_u64(args, "port")
        .ok_or_else(|| BridgeError::InvalidArgs("'port' is required and must be an integer".into()))?;
    if port == 0 || port > 65_535 {
        return Err(BridgeError::InvalidArgs("'port' must be between 1 and 65535".into()));
    }
    Ok(port as i32)
}

fn mp_create_server(args: &Value) -> Result<Value, BridgeError> {
    let port = require_port(args)?;
    let max_clients = optional_u64(args, "max_clients").unwrap_or(32).min(4095) as i32;
    let mut peer = ENetMultiplayerPeer::new_gd();
    let err = peer.create_server_ex(port).max_clients(max_clients).done();
    if err != godot::global::Error::OK {
        return Err(BridgeError::NetworkError(format!("could not create ENet server on port {port}: {err:?}")));
    }
    multiplayer_api()?.set_multiplayer_peer(&peer.upcast::<MultiplayerPeer>());
    Ok(json!({ "role": "server", "port": port, "unique_id": 1 }))
}

fn mp_create_client(args: &Value) -> Result<Value, BridgeError> {
    let address = require_str(args, "address")?;
    let port = require_port(args)?;
    let mut peer = ENetMultiplayerPeer::new_gd();
    let err = peer.create_client(address.as_str(), port);
    if err != godot::global::Error::OK {
        return Err(BridgeError::NetworkError(format!(
            "could not start ENet client for {address}:{port}: {err:?}"
        )));
    }
    let unique_id = peer.get_unique_id();
    multiplayer_api()?.set_multiplayer_peer(&peer.upcast::<MultiplayerPeer>());
    // The connection completes asynchronously; poll op=status for
    // connection_status and the peer list.
    Ok(json!({ "role": "client", "address": address, "port": port, "unique_id": unique_id }))
}

fn mp_disconnect() -> Result<Value, BridgeError> {
    let mut api = multiplayer_api()?;
    if let Some(mut peer) = api.get_multiplayer_peer() {
        peer.close();
    }
    api.set_multiplayer_peer(Gd::null_arg());
    Ok(json!({ "disconnected": true }))
}

fn mp_status() -> Result<Value, BridgeError> {
    let api = multiplayer_api()?;
    if !api.has_multiplayer_peer() {
        return Ok(json!({ "active": false }));
    }
    let peer = api.get_multiplayer_peer();
    let status = peer.as_ref().map(|p| format!("{:?}", p.get_connection_status()));
    Ok(json!({
        "active": true,
        "unique_id": api.get_unique_id(),
        "connection_status": status,
        "peers": api.get_peers().as_slice().to_vec(),
    }))
}

fn mp_rpc(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let method = require_str(args, "method")?;
    let call_args = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(json_to_variant).collect::<Result<Vec<Variant>, _>>()?,
        Some(_) => return Err(BridgeError::InvalidArgs("'args' must be an array".into())),
    };
    let mut node = resolve_node(&node_path)?;
    let err = match args.get("peer_id").and_then(Value::as_i64) {
        Some(peer_id) => node.rpc_id(peer_id, method.as_str(), &call_args),
        None => node.rpc(method.as_str(), &call_args),
    };
    if err != godot::global::Error::OK {
        return Err(BridgeError::NetworkError(format!("rpc '{method}' on {node_path} failed: {err:?}")));
    }
    Ok(json!({ "node_path": node_path, "method": method, "sent": true }))
}

fn mp_rpc_config(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let method = require_str(args, "method")?;
    let config = args
        .get("config")
        .ok_or_else(|| BridgeError::InvalidArgs("'config' is required (an rpc_config dictionary)".into()))?;
    if !config.is_object() {
        return Err(BridgeError::InvalidArgs("'config' must be an object map".into()));
    }
    let variant = json_to_variant(config)?;
    let mut node = resolve_node(&node_path)?;
    node.rpc_config(method.as_str(), &variant);
    Ok(json!({ "node_path": node_path, "method": method, "configured": variant_to_json(&variant) }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> FrameContext {
        FrameContext { frame_index: 1, last_delta_ms: 16.0 }
    }

    fn assert_invalid_args(outcome: HandlerOutcome) {
        match outcome {
            HandlerOutcome::Done(Err(err)) => assert_eq!(err.code(), "invalid_args"),
            _ => panic!("expected invalid_args before any engine call"),
        }
    }

    #[test]
    fn http_request_requires_url_and_validates_scheme() {
        assert_invalid_args(http_request(&json!({}), &ctx()));
        assert_invalid_args(http_request(&json!({ "url": "ftp://x" }), &ctx()));
    }

    #[test]
    fn http_request_rejects_bad_method_and_headers() {
        assert_invalid_args(http_request(&json!({ "url": "http://x", "method": "YEET" }), &ctx()));
        assert_invalid_args(http_request(&json!({ "url": "http://x", "headers": 5 }), &ctx()));
        assert_invalid_args(http_request(&json!({ "url": "http://x", "headers": { "A": 1 } }), &ctx()));
    }

    #[test]
    fn websocket_validates_op_id_and_scheme() {
        assert_invalid_args(websocket(&json!({}), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "teleport" }), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "connect", "url": "http://x" }), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "send" }), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "send", "id": 1 }), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "recv" }), &ctx()));
        assert_invalid_args(websocket(&json!({ "op": "close" }), &ctx()));
    }

    #[test]
    fn multiplayer_validates_op_and_ports() {
        assert_invalid_args(multiplayer(&json!({}), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "warp" }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "create_server" }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "create_server", "port": 0 }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "create_server", "port": 700000 }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "create_client", "port": 4000 }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "rpc", "node_path": "/root/X" }), &ctx()));
        assert_invalid_args(multiplayer(&json!({ "op": "rpc_config", "node_path": "/root/X", "method": "m" }), &ctx()));
    }

    #[test]
    fn header_parsing_accepts_both_shapes() {
        let map = parse_headers(&json!({ "headers": { "X-A": "1" } })).unwrap();
        assert_eq!(map, vec!["X-A: 1"]);
        let arr = parse_headers(&json!({ "headers": ["X-B: 2"] })).unwrap();
        assert_eq!(arr, vec!["X-B: 2"]);
        assert!(parse_headers(&json!({})).unwrap().is_empty());
    }
}
