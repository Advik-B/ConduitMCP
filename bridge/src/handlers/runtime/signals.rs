//! Signal handling on the game bridge, consolidated behind an `op`
//! discriminator (whitepaper sections 6.6 and 7.1): connect, disconnect, emit,
//! list, and await.
//!
//! Every op takes the target grammar, so the emitter may be a node, a
//! singleton, or a handle-held object; `crate::handlers::signals` holds the
//! half of that which the editor bridge shares. The connection destination
//! takes the grammar too, under `receiver`: this tool named the emitter
//! `node_path` and the destination `target_path` before `target` existed, so
//! the destination could not also be called `target` without meaning two
//! things.

use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::optional_str;
use crate::handlers::runtime::support::{require_str, resolve_target};
use crate::handlers::signals::{self as core, Endpoint};
use crate::handlers::target::{target_response, target_spec, target_spec_named};
use crate::protocol::BridgeError;

/// The live-connection flag set. Unlike the editor's persisted connections
/// there is nothing to serialize into, so a runtime connect carries no flags.
const CONNECT_NONE: u32 = 0;

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

/// Resolve both ends of a connection: the emitter under `target`/`node_path`
/// and the destination under `receiver`/`target_path`.
fn endpoints(args: &Value) -> Result<(Endpoint, Endpoint), BridgeError> {
    let source_spec = target_spec(args)?;
    let receiver_spec = target_spec_named(args, "receiver", "target_path")?;
    let source = Endpoint { object: resolve_target(&source_spec)?, spec: source_spec };
    let receiver = Endpoint { object: resolve_target(&receiver_spec)?, spec: receiver_spec };
    Ok((source, receiver))
}

fn connect(args: &Value) -> Result<Value, BridgeError> {
    let signal = require_str(args, "signal")?;
    let method = require_str(args, "method")?;
    let (mut source, receiver) = endpoints(args)?;

    core::connect_signal(&mut source, &signal, &receiver, &method, CONNECT_NONE)?;

    Ok(target_response(
        &source.spec,
        json!({
            "connected": true,
            "signal": signal,
            "receiver": receiver.label(),
            "method": method,
        }),
    ))
}

fn disconnect(args: &Value) -> Result<Value, BridgeError> {
    let signal = require_str(args, "signal")?;
    let method = require_str(args, "method")?;
    let (mut source, receiver) = endpoints(args)?;

    core::disconnect_signal(&mut source, &signal, &receiver, &method)?;

    Ok(target_response(
        &source.spec,
        json!({
            "disconnected": true,
            "signal": signal,
            "receiver": receiver.label(),
            "method": method,
        }),
    ))
}

fn emit(args: &Value) -> Result<Value, BridgeError> {
    let spec = target_spec(args)?;
    let signal = require_str(args, "signal")?;
    let mut object = resolve_target(&spec)?;
    core::emit_signal(&mut object, &signal, &spec.label(), args)?;
    Ok(target_response(&spec, json!({ "emitted": true, "signal": signal })))
}

fn list(args: &Value) -> Result<Value, BridgeError> {
    let spec = target_spec(args)?;
    let object = resolve_target(&spec)?;
    let filter = optional_str(args, "signal");
    let signals = core::list_signals(&object, filter.as_deref());
    Ok(target_response(&spec, json!({ "signals": signals })))
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
    let object = match resolve_target(&spec) {
        Ok(object) => object,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    core::await_signal(object, &signal, &spec, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> FrameContext {
        FrameContext { frame_index: 1, last_delta_ms: 16.0 }
    }

    fn error_code(outcome: HandlerOutcome) -> String {
        match outcome {
            HandlerOutcome::Done(Err(err)) => err.code().to_string(),
            _ => panic!("expected an error before any engine call"),
        }
    }

    #[test]
    fn op_is_required_and_unknown_ops_are_rejected() {
        assert_eq!(error_code(signal(&json!({}), &ctx())), "invalid_args");
        assert_eq!(error_code(signal(&json!({ "op": "subscribe" }), &ctx())), "invalid_args");
    }

    #[test]
    fn await_needs_a_target_and_a_signal_name() {
        assert_eq!(error_code(signal(&json!({ "op": "await" }), &ctx())), "invalid_args");
        assert_eq!(
            error_code(signal(&json!({ "op": "await", "target": "object:1" }), &ctx())),
            "invalid_args"
        );
    }

    #[test]
    fn connect_rejects_a_target_and_a_node_path_together() {
        let both = json!({
            "op": "connect",
            "signal": "timeout",
            "method": "on_timeout",
            "target": "singleton:Input",
            "node_path": "/root/Main",
        });
        assert_eq!(error_code(signal(&both, &ctx())), "invalid_args");
    }

    #[test]
    fn connect_rejects_a_receiver_and_a_target_path_together() {
        let both = json!({
            "op": "connect",
            "signal": "timeout",
            "method": "on_timeout",
            "target": "/root/Main/Timer",
            "receiver": "object:2",
            "target_path": "/root/Main",
        });
        assert_eq!(error_code(signal(&both, &ctx())), "invalid_args");
    }

    #[test]
    fn emit_rejects_a_non_array_args_field() {
        let args = json!({ "op": "emit", "node_path": "/root/Main", "signal": "ready", "args": 3 });
        // The argument shape is checked before the engine is touched only once
        // the target resolves, so assert on the conversion helper directly.
        assert_eq!(core::emit_args(&args).unwrap_err().code(), "invalid_args");
    }
}
