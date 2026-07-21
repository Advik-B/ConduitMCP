//! Signal handling, consolidated behind an `op` discriminator (whitepaper
//! sections 6.6 and 7.1): connect, disconnect, emit, list, and await.

use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::eval::run_source;
use crate::handlers::runtime::support::{require_str, resolve_node, signal_names};
use crate::protocol::BridgeError;
use crate::variant_json::json_to_variant;

pub fn signal(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
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

fn connect(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal = require_str(args, "signal")?;
    let target_path = require_str(args, "target_path")?;
    let method = require_str(args, "method")?;

    let mut source = resolve_node(&node_path)?;
    let target = resolve_node(&target_path)?;
    let callable = Callable::from_object_method(&target, method.as_str());
    let error = source.connect(signal.as_str(), &callable);
    if error != godot::global::Error::OK {
        return Err(BridgeError::CallFailed(format!(
            "could not connect {node_path}.{signal} to {target_path}.{method} ({error:?})"
        )));
    }
    Ok(json!({ "connected": true, "signal": signal }))
}

fn disconnect(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal = require_str(args, "signal")?;
    let target_path = require_str(args, "target_path")?;
    let method = require_str(args, "method")?;

    let mut source = resolve_node(&node_path)?;
    let target = resolve_node(&target_path)?;
    let callable = Callable::from_object_method(&target, method.as_str());
    if !source.is_connected(signal.as_str(), &callable) {
        return Err(BridgeError::InvalidArgs(format!(
            "{node_path}.{signal} is not connected to {target_path}.{method}"
        )));
    }
    source.disconnect(signal.as_str(), &callable);
    Ok(json!({ "disconnected": true, "signal": signal }))
}

fn emit(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let signal = require_str(args, "signal")?;
    let varargs = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            items.iter().map(json_to_variant).collect::<Result<Vec<Variant>, BridgeError>>()?
        }
        Some(_) => return Err(BridgeError::InvalidArgs("'args' must be an array".into())),
    };
    let mut source = resolve_node(&node_path)?;
    let error = source.emit_signal(signal.as_str(), &varargs);
    if error != godot::global::Error::OK {
        return Err(BridgeError::CallFailed(format!("emit of {node_path}.{signal} failed ({error:?})")));
    }
    Ok(json!({ "emitted": true, "signal": signal }))
}

fn list(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let node = resolve_node(&node_path)?;
    let signals: Vec<Value> = signal_names(&node)
        .into_iter()
        .map(|name| {
            let connections = node.get_signal_connection_list(name.as_str()).len();
            json!({ "name": name, "connection_count": connections })
        })
        .collect();
    Ok(json!({ "node_path": node_path, "signals": signals }))
}

/// Await a signal by delegating to the evaluation runner, which handles the
/// cross-frame suspension. The broker's timeout bounds the wait.
fn await_signal(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let node_path = match require_str(args, "node_path") {
        Ok(value) => value,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    let signal = match require_str(args, "signal") {
        Ok(value) => value,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    // serde_json string encoding is a valid GDScript string literal, so paths
    // and names with quotes cannot break out of the generated source.
    let path_literal = Value::String(node_path).to_string();
    let signal_literal = Value::String(signal).to_string();
    let source = format!("return await Signal(get_node({path_literal}), {signal_literal})");
    run_source(&source, ctx)
}
