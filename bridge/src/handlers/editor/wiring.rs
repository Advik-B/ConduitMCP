//! Persisted signal connections and persistent node groups on the edited
//! scene (whitepaper section 8 "Scene structure"). Connections always carry
//! CONNECT_PERSIST so they serialize on save; both mutations are undo-wrapped
//! through dynamic varcalls on the undo manager, the same idiom the node
//! handlers use for add_child/set_owner.

use godot::builtin::StringName;
use godot::classes::Node;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_bool, optional_str, require_str};
use crate::handlers::editor::support::{edited_scene_root, relative_path, resolve_editor_node, undo_redo};
use crate::protocol::BridgeError;

// ConnectFlags: CONNECT_DEFERRED and CONNECT_PERSIST.
const CONNECT_DEFERRED: i64 = 1;
const CONNECT_PERSIST: i64 = 2;

fn call_error(action: &str, err: godot::meta::error::CallError) -> BridgeError {
    BridgeError::Internal(format!("{action} failed: {err}"))
}

pub fn scene_signal(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "connect" => connect(args),
            "disconnect" => disconnect(args),
            "list" => list(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown signal op '{other}'; expected connect, disconnect, or list"
            ))),
        }
    })())
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

fn connect(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal = require_str(args, "signal")?;
    let target_path = require_str(args, "target_path")?;
    let method = require_str(args, "method")?;
    let deferred = optional_bool(args, "deferred").unwrap_or(false);

    let source = resolve_editor_node(&node_path)?;
    let target = resolve_editor_node(&target_path)?;
    if !source.has_signal(signal.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("node '{node_path}' has no signal '{signal}'")));
    }
    let callable = Callable::from_object_method(&target, method.as_str());
    if source.is_connected(signal.as_str(), &callable) {
        return Err(BridgeError::AlreadyExists(format!(
            "{node_path}.{signal} is already connected to {target_path}.{method}"
        )));
    }

    let flags = CONNECT_PERSIST | if deferred { CONNECT_DEFERRED } else { 0 };
    let signal_name = StringName::from(signal.as_str());
    let mut ur = undo_redo()?;
    let action_name = format!("Conduit: Connect {signal} to {method}");
    ur.create_action(action_name.as_str());
    ur.try_add_do_method(&source, "connect", &[signal_name.to_variant(), callable.to_variant(), flags.to_variant()])
        .map_err(|e| call_error("add_do_method(connect)", e))?;
    ur.try_add_undo_method(&source, "disconnect", &[signal_name.to_variant(), callable.to_variant()])
        .map_err(|e| call_error("add_undo_method(disconnect)", e))?;
    ur.commit_action();

    let mut result = json!({
        "connected": true,
        "signal": signal,
        "target_path": target_path,
        "method": method,
        "flags": flags,
        "action_name": action_name,
    });
    // Wiring before writing the handler is a legitimate order of operations
    // (Godot's own connect dialog allows it), so a missing method is a note,
    // not an error.
    if !target.has_method(method.as_str()) {
        result["note"] = json!(format!("target '{target_path}' does not yet have a method '{method}'"));
    }
    Ok(result)
}

fn disconnect(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal = require_str(args, "signal")?;
    let target_path = require_str(args, "target_path")?;
    let method = require_str(args, "method")?;

    let source = resolve_editor_node(&node_path)?;
    let target = resolve_editor_node(&target_path)?;
    let existing = persisted_connections(&source, Some(signal.as_str()))
        .into_iter()
        .find(|c| c.method == method && c.target.as_ref() == Some(&target))
        .ok_or_else(|| {
            BridgeError::InvalidArgs(format!(
                "{node_path}.{signal} has no persisted connection to {target_path}.{method}"
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

    Ok(json!({ "disconnected": true, "signal": signal, "action_name": action_name }))
}

fn list(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal_filter = optional_str(args, "signal");
    let node = resolve_editor_node(&node_path)?;
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
    Ok(json!({ "node_path": node_path, "connections": connections }))
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
        assert_invalid_args(scene_signal(&json!({ "op": "emit" }), &ctx()));
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
    fn node_group_requires_op_and_arguments() {
        assert_invalid_args(node_group(&json!({}), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "join" }), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "add" }), &ctx()));
        assert_invalid_args(node_group(&json!({ "op": "add", "node_path": "Player" }), &ctx()));
    }
}
