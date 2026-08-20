//! Persisted signal connections and persistent node groups on the edited
//! scene (whitepaper section 8 "Scene structure").
//!
//! A connection between two nodes of the edited scene carries CONNECT_PERSIST
//! so it serializes on save, and is undo-wrapped through dynamic varcalls on
//! the undo manager, the same idiom the node handlers use for
//! add_child/set_owner.
//!
//! A connection with a singleton or a handle-held object at either end is
//! neither. A persisted connection serializes both ends, so there is no scene
//! file for this one to go into, and the edited scene's history does not own
//! it; it is made live, without PERSIST, and the response says
//! `persisted: false, undoable: false` rather than letting `gd_undo` claim to
//! revert something it never held. That is the argument `gd_scene_node_call`
//! and the singleton property write already make.

use godot::builtin::StringName;
use godot::classes::Node;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_bool, optional_str, require_str};
use crate::handlers::editor::support::{
    edited_scene_root, relative_path, resolve_editor_node, resolve_editor_target, undo_redo,
};
use crate::handlers::signals as core;
use crate::handlers::target::{target_response, target_spec, target_spec_named, TargetSpec};
use crate::protocol::BridgeError;

// ConnectFlags: CONNECT_DEFERRED and CONNECT_PERSIST.
const CONNECT_DEFERRED: i64 = 1;
const CONNECT_PERSIST: i64 = 2;

fn call_error(action: &str, err: godot::meta::error::CallError) -> BridgeError {
    BridgeError::Internal(format!("{action} failed: {err}"))
}

pub fn scene_signal(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let op = match require_str(args, "op") {
        Ok(op) => op,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    match op.as_str() {
        "connect" => HandlerOutcome::Done(connect(args)),
        "disconnect" => HandlerOutcome::Done(disconnect(args)),
        "emit" => HandlerOutcome::Done(emit(args)),
        "list" => HandlerOutcome::Done(list(args)),
        "await" => await_signal(args, ctx),
        other => HandlerOutcome::Done(Err(BridgeError::InvalidArgs(format!(
            "unknown signal op '{other}'; expected connect, disconnect, emit, list, or await"
        )))),
    }
}

/// A persisted connection's row in `get_signal_connection_list`, decoded to
/// the pieces the handlers need.
struct Connection {
    signal: String,
    target: Option<Gd<Node>>,
    method: String,
    flags: i64,
}

fn persisted_connections(node: &Gd<Node>, signal_filter: Option<&str>) -> Vec<Connection> {
    let mut connections = Vec::new();
    for entry in node.get_signal_list().iter_shared() {
        let name = entry.get(&GString::from("name")).map(|v| v.to_string()).unwrap_or_default();
        if name.is_empty() || signal_filter.is_some_and(|filter| filter != name) {
            continue;
        }
        for row in node.get_signal_connection_list(name.as_str()).iter_shared() {
            let flags = row.get(&GString::from("flags")).and_then(|v| v.try_to::<i64>().ok()).unwrap_or(0);
            if flags & CONNECT_PERSIST == 0 {
                continue;
            }
            let callable = row.get(&GString::from("callable")).and_then(|v| v.try_to::<Callable>().ok());
            let (target, method) = match &callable {
                Some(c) => (
                    c.object().and_then(|o| o.try_cast::<Node>().ok()),
                    c.method_name().map(|m| m.to_string()).unwrap_or_default(),
                ),
                None => (None, String::new()),
            };
            connections.push(Connection { signal: name.clone(), target, method, flags });
        }
    }
    connections
}

/// One end of a persisted connection: a node of the edited scene, and the path
/// the caller named it by.
struct NodeEnd {
    spec: TargetSpec,
    node: Gd<Node>,
}

/// The node of the edited scene a spec names, or `None` when it names
/// something else. Only a node-to-node connection can be persisted, so this is
/// what decides which of the two connect paths a call takes.
fn edited_node(spec: &TargetSpec) -> Result<Option<NodeEnd>, BridgeError> {
    match spec {
        TargetSpec::Node(path) => {
            Ok(Some(NodeEnd { spec: spec.clone(), node: resolve_editor_node(path)? }))
        }
        _ => Ok(None),
    }
}

/// Resolve a spec into the endpoint pair the shared signal core takes.
fn endpoint(spec: &TargetSpec) -> Result<core::Endpoint, BridgeError> {
    Ok(core::Endpoint { object: resolve_editor_target(spec)?, spec: spec.clone() })
}

fn connect(args: &Value) -> Result<Value, BridgeError> {
    let source_spec = target_spec(args)?;
    let receiver_spec = target_spec_named(args, "receiver", "target_path")?;
    let signal = require_str(args, "signal")?;
    let method = require_str(args, "method")?;
    let deferred = optional_bool(args, "deferred").unwrap_or(false);

    match (edited_node(&source_spec)?, edited_node(&receiver_spec)?) {
        (Some(source), Some(receiver)) => connect_persisted(source, receiver, &signal, &method, deferred),
        _ => connect_live(&source_spec, &receiver_spec, &signal, &method, deferred),
    }
}

/// Two nodes of the edited scene: CONNECT_PERSIST, undo-wrapped, saved with the
/// scene. Unchanged from before the target grammar reached this tool.
fn connect_persisted(
    source_end: NodeEnd,
    receiver_end: NodeEnd,
    signal: &str,
    method: &str,
    deferred: bool,
) -> Result<Value, BridgeError> {
    let (source, target) = (source_end.node, receiver_end.node);
    let (source_spec, receiver_spec) = (source_end.spec, receiver_end.spec);
    let source_label = source_spec.label();
    let receiver_label = receiver_spec.label();
    if !source.has_signal(signal) {
        return Err(BridgeError::InvalidArgs(format!("node '{source_label}' has no signal '{signal}'")));
    }
    let callable = Callable::from_object_method(&target, method);
    if source.is_connected(signal, &callable) {
        return Err(BridgeError::AlreadyExists(format!(
            "{source_label}.{signal} is already connected to {receiver_label}.{method}"
        )));
    }

    let flags = CONNECT_PERSIST | if deferred { CONNECT_DEFERRED } else { 0 };
    let signal_name = StringName::from(signal);
    let mut ur = undo_redo()?;
    let action_name = format!("Conduit: Connect {signal} to {method}");
    ur.create_action(action_name.as_str());
    ur.try_add_do_method(&source, "connect", &[signal_name.to_variant(), callable.to_variant(), flags.to_variant()])
        .map_err(|e| call_error("add_do_method(connect)", e))?;
    ur.try_add_undo_method(&source, "disconnect", &[signal_name.to_variant(), callable.to_variant()])
        .map_err(|e| call_error("add_undo_method(disconnect)", e))?;
    ur.commit_action();

    let mut result = target_response(
        &source_spec,
        json!({
            "connected": true,
            "signal": signal,
            "receiver": receiver_label,
            "target_path": receiver_label,
            "method": method,
            "flags": flags,
            "persisted": true,
            "undoable": true,
            "action_name": action_name,
        }),
    );
    // Wiring before writing the handler is a legitimate order of operations
    // (Godot's own connect dialog allows it), so a missing method is a note,
    // not an error.
    if !target.has_method(method) {
        result["note"] = json!(format!("target '{receiver_label}' does not yet have a method '{method}'"));
    }
    Ok(result)
}

/// Anything else -- a singleton or a handle-held object at either end -- is a
/// live connection in the editor process, gone when the editor exits. A
/// persisted connection serializes both ends into the scene file, so one end
/// outside the edited scene is enough to make persistence impossible. Reported
/// as unpersisted and un-undoable rather than pretending.
fn connect_live(
    source_spec: &TargetSpec,
    receiver_spec: &TargetSpec,
    signal: &str,
    method: &str,
    deferred: bool,
) -> Result<Value, BridgeError> {
    let mut source = endpoint(source_spec)?;
    let receiver = endpoint(receiver_spec)?;
    let flags = if deferred { CONNECT_DEFERRED as u32 } else { 0 };
    core::connect_signal(&mut source, signal, &receiver, method, flags)?;

    let receiver_label = receiver.label();
    let mut result = target_response(
        source_spec,
        json!({
            "connected": true,
            "signal": signal,
            "receiver": receiver_label,
            "method": method,
            "flags": flags,
            "persisted": false,
            "undoable": false,
            "note": "one end is not a node of the edited scene, so the connection is live in the editor process only: it is not saved with the scene and gd_undo does not revert it",
        }),
    );
    if !receiver.object.has_method(method) {
        result["method_note"] =
            json!(format!("receiver '{receiver_label}' does not yet have a method '{method}'"));
    }
    Ok(result)
}

fn disconnect(args: &Value) -> Result<Value, BridgeError> {
    let source_spec = target_spec(args)?;
    let receiver_spec = target_spec_named(args, "receiver", "target_path")?;
    let signal = require_str(args, "signal")?;
    let method = require_str(args, "method")?;

    let (source, target) = match (edited_node(&source_spec)?, edited_node(&receiver_spec)?) {
        (Some(source), Some(receiver)) => (source.node, receiver.node),
        _ => return disconnect_live(&source_spec, &receiver_spec, &signal, &method),
    };

    let source_label = source_spec.label();
    let receiver_label = receiver_spec.label();
    let existing = persisted_connections(&source, Some(signal.as_str()))
        .into_iter()
        .find(|c| c.method == method && c.target.as_ref() == Some(&target))
        .ok_or_else(|| {
            BridgeError::InvalidArgs(format!(
                "{source_label}.{signal} has no persisted connection to {receiver_label}.{method}"
            ))
        })?;

    let callable = Callable::from_object_method(&target, method.as_str());
    let signal_name = StringName::from(signal.as_str());
    let mut ur = undo_redo()?;
    let action_name = format!("Conduit: Disconnect {signal} from {method}");
    ur.create_action(action_name.as_str());
    ur.try_add_do_method(&source, "disconnect", &[signal_name.to_variant(), callable.to_variant()])
        .map_err(|e| call_error("add_do_method(disconnect)", e))?;
    ur.try_add_undo_method(
        &source,
        "connect",
        &[signal_name.to_variant(), callable.to_variant(), existing.flags.to_variant()],
    )
    .map_err(|e| call_error("add_undo_method(connect)", e))?;
    ur.commit_action();

    Ok(target_response(
        &source_spec,
        json!({
            "disconnected": true,
            "signal": signal,
            "persisted": true,
            "undoable": true,
            "action_name": action_name,
        }),
    ))
}

fn disconnect_live(
    source_spec: &TargetSpec,
    receiver_spec: &TargetSpec,
    signal: &str,
    method: &str,
) -> Result<Value, BridgeError> {
    let mut source = endpoint(source_spec)?;
    let receiver = endpoint(receiver_spec)?;
    core::disconnect_signal(&mut source, signal, &receiver, method)?;
    Ok(target_response(
        source_spec,
        json!({
            "disconnected": true,
            "signal": signal,
            "receiver": receiver.label(),
            "method": method,
            "persisted": false,
            "undoable": false,
        }),
    ))
}

/// A node of the edited scene reports its *persisted* connections, which is
/// what the Node dock shows and what a save writes. Anything else has no
/// persisted connections to report, so it reports its declared signals with
/// their live connection counts instead, the way `gd_signal list` does.
fn list(args: &Value) -> Result<Value, BridgeError> {
    let spec = target_spec(args)?;
    let signal_filter = optional_str(args, "signal");

    let Some(end) = edited_node(&spec)? else {
        let object = resolve_editor_target(&spec)?;
        return Ok(target_response(
            &spec,
            json!({ "signals": core::list_signals(&object, signal_filter.as_deref()) }),
        ));
    };
    let node = end.node;

    let root = edited_scene_root()?;
    let connections: Vec<Value> = persisted_connections(&node, signal_filter.as_deref())
        .into_iter()
        .map(|c| {
            json!({
                "signal": c.signal,
                "target_path": c.target.as_ref().map(|t| relative_path(&root, t)),
                "method": c.method,
                "deferred": c.flags & CONNECT_DEFERRED != 0,
            })
        })
        .collect();
    Ok(target_response(
        &spec,
        json!({
            "connections": connections,
            "signals": core::list_signals(&node.clone().upcast(), signal_filter.as_deref()),
        }),
    ))
}

fn emit(args: &Value) -> Result<Value, BridgeError> {
    let spec = target_spec(args)?;
    let signal = require_str(args, "signal")?;
    let mut object = resolve_editor_target(&spec)?;
    core::emit_signal(&mut object, &signal, &spec.label(), args)?;
    Ok(target_response(&spec, json!({ "emitted": true, "signal": signal, "undoable": false })))
}

fn await_signal(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let spec = match target_spec(args) {
        Ok(spec) => spec,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    let signal = match require_str(args, "signal") {
        Ok(value) => value,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    let object = match resolve_editor_target(&spec) {
        Ok(object) => object,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    core::await_signal(object, &signal, &spec, ctx)
}

pub fn node_group(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "add" => group_add(args),
            "remove" => group_remove(args),
            "list" => group_list(args),
            other => {
                Err(BridgeError::InvalidArgs(format!("unknown group op '{other}'; expected add, remove, or list")))
            }
        }
    })())
}

fn group_add(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let group = require_str(args, "group")?;
    let node = resolve_editor_node(&node_path)?;
    if node.is_in_group(group.as_str()) {
        return Err(BridgeError::AlreadyExists(format!("node '{node_path}' is already in group '{group}'")));
    }

    let group_name = StringName::from(group.as_str());
    let mut ur = undo_redo()?;
    let action_name = format!("Conduit: Add {} to group {group}", node.get_name());
    ur.create_action(action_name.as_str());
    // The second argument marks the membership persistent so it serializes on
    // save, matching the editor's Groups dock.
    ur.try_add_do_method(&node, "add_to_group", &[group_name.to_variant(), true.to_variant()])
        .map_err(|e| call_error("add_do_method(add_to_group)", e))?;
    ur.try_add_undo_method(&node, "remove_from_group", &[group_name.to_variant()])
        .map_err(|e| call_error("add_undo_method(remove_from_group)", e))?;
    ur.commit_action();

    Ok(json!({ "node_path": node_path, "group": group, "added": true, "action_name": action_name }))
}

fn group_remove(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let group = require_str(args, "group")?;
    let node = resolve_editor_node(&node_path)?;
    if !node.is_in_group(group.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("node '{node_path}' is not in group '{group}'")));
    }

    let group_name = StringName::from(group.as_str());
    let mut ur = undo_redo()?;
    let action_name = format!("Conduit: Remove {} from group {group}", node.get_name());
    ur.create_action(action_name.as_str());
    ur.try_add_do_method(&node, "remove_from_group", &[group_name.to_variant()])
        .map_err(|e| call_error("add_do_method(remove_from_group)", e))?;
    ur.try_add_undo_method(&node, "add_to_group", &[group_name.to_variant(), true.to_variant()])
        .map_err(|e| call_error("add_undo_method(add_to_group)", e))?;
    ur.commit_action();

    Ok(json!({ "node_path": node_path, "group": group, "removed": true, "action_name": action_name }))
}

fn group_list(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let include_internal = optional_bool(args, "include_internal").unwrap_or(false);
    let node = resolve_editor_node(&node_path)?;
    let groups: Vec<String> = node
        .get_groups()
        .iter_shared()
        .map(|g| g.to_string())
        .filter(|g| include_internal || !g.starts_with('_'))
        .collect();
    Ok(json!({ "node_path": node_path, "groups": groups }))
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
            _ => panic!("expected an invalid_args error before any engine call"),
        }
    }

    #[test]
    fn scene_signal_requires_op_and_rejects_unknown_ops() {
        assert_invalid_args(scene_signal(&json!({}), &ctx()));
        assert_invalid_args(scene_signal(&json!({ "op": "subscribe" }), &ctx()));
    }

    #[test]
    fn signal_connect_requires_all_endpoint_arguments() {
        assert_invalid_args(scene_signal(&json!({ "op": "connect" }), &ctx()));
        assert_invalid_args(scene_signal(&json!({ "op": "connect", "node_path": "Timer" }), &ctx()));
        assert_invalid_args(scene_signal(
            &json!({ "op": "connect", "node_path": "Timer", "signal": "timeout", "target_path": "." }),
            &ctx(),
        ));
    }

    #[test]
    fn a_conflicting_endpoint_pair_is_rejected() {
        assert_invalid_args(scene_signal(
            &json!({ "op": "connect", "node_path": "Timer", "target": "singleton:EditorInterface" }),
            &ctx(),
        ));
        assert_invalid_args(scene_signal(
            &json!({
                "op": "connect",
                "node_path": "Timer",
                "signal": "timeout",
                "method": "on_timeout",
                "target_path": ".",
                "receiver": "object:1",
            }),
            &ctx(),
        ));
    }

    #[test]
    fn await_requires_a_target_and_a_signal() {
        assert_invalid_args(scene_signal(&json!({ "op": "await" }), &ctx()));
        assert_invalid_args(scene_signal(&json!({ "op": "await", "target": "object:1" }), &ctx()));
    }

    #[test]
    fn node_group_requires_op_and_arguments() {
        assert_invalid_args(node_group(&json!({}), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "join" }), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "add" }), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "add", "node_path": "Player" }), &ctx()));
    }
}
