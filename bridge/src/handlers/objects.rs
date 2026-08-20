//! The object-handle bookkeeping tool, registered as `gd_object` on the game
//! bridge and `gd_scene_object` on the editor bridge.
//!
//! Two names for one handler, because the table is per process: a handle taken
//! out of a running game means nothing to the editor and vice versa. The split
//! matches the one the generic verbs already use (`gd_node_call` is the game,
//! `gd_scene_node_call` is the editor), so which process a handle belongs to is
//! visible in the call rather than hidden in an argument.
//!
//! There is deliberately no `info` op. `gd_node_get_info target=object:3`
//! already answers on the game bridge, and on the editor bridge `gd_classdb`
//! answers from the class name `list` reports, so an op here would be a third
//! way to ask a question two tools already answer.

use godot::classes::ClassDb;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::runtime::support::{apply_properties, optional_properties};
use crate::handles;
use crate::protocol::BridgeError;

pub fn object_tool(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "create" => create(args),
            "list" => Ok(json!({
                "handles": handles::list(),
                "count": handles::count(),
                "max": handles::MAX_HANDLES,
            })),
            "release" => release(args),
            "release_all" => Ok(json!({ "released": handles::release_all() })),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected create, list, release, or release_all"
            ))),
        }
    })())
}

/// Construct an engine object and hand back a handle on it.
///
/// Restricted to `RefCounted` classes, which is what makes `release` able to
/// promise it never leaks and never frees something out from under a caller:
/// the handle *is* the ownership, and dropping it is the whole of the cleanup.
///
/// The restriction costs almost nothing. The manually managed members of this
/// cluster -- `PhysicsDirectSpaceState3D`, `EditorSelection`, `TileData` --
/// cannot be instantiated anyway; they are handed out by a call and reached
/// with `capture`. Nodes have two dedicated tools already, and a Node created
/// here would be an orphan whose ownership nothing could describe.
fn create(args: &Value) -> Result<Value, BridgeError> {
    let class = require_str(args, "class")?;
    let db = ClassDb::singleton();
    if !db.class_exists(class.as_str()) {
        return Err(BridgeError::InvalidArgs(format!(
            "class '{class}' does not exist in this engine build"
        )));
    }
    if db.is_parent_class(class.as_str(), "Node") {
        return Err(BridgeError::InvalidArgs(format!(
            "'{class}' is a Node; add it to a tree with gd_tree_mutate add_node in a running game, or gd_node_add in the editor, rather than holding it as a free-floating object"
        )));
    }
    if !db.is_parent_class(class.as_str(), "RefCounted") {
        return Err(BridgeError::InvalidArgs(format!(
            "'{class}' is not RefCounted, so a handle could not own the instance and releasing it could not free it. Objects of this kind are obtained from a call and taken with capture, not constructed"
        )));
    }
    if !db.can_instantiate(class.as_str()) {
        return Err(BridgeError::InvalidArgs(format!(
            "class '{class}' cannot be instantiated; it is abstract or engine-internal"
        )));
    }

    let mut object = db
        .instantiate(class.as_str())
        .try_to::<Gd<Object>>()
        .map_err(|_| BridgeError::CallFailed(format!("failed to instantiate '{class}'")))?;
    // Initial properties are applied before the handle exists, so a rejected
    // property name costs the caller a failed call rather than a live handle on
    // a half-configured object.
    let applied = match optional_properties(args)? {
        Some(properties) => apply_properties(&mut object, properties)?,
        None => Vec::new(),
    };

    let actual = object.get_class().to_string();
    let id = handles::mint(object)?;
    Ok(json!({
        "handle": handles::format_handle(id),
        "id": id,
        "class": actual,
        "refcounted": true,
        "properties_set": applied,
        "held": handles::count(),
        "max": handles::MAX_HANDLES,
    }))
}

fn release(args: &Value) -> Result<Value, BridgeError> {
    let id = handle_arg(args)?;
    let class = handles::class_of(id);
    if !handles::release(id) {
        return Err(BridgeError::ObjectNotFound(format!(
            "no object handle {}; nothing to release",
            handles::format_handle(id)
        )));
    }
    Ok(json!({
        "released": handles::format_handle(id),
        "class": class,
        "held": handles::count(),
    }))
}

/// The `handle` argument, in either the full (`object:3`) or bare (`3`) form
/// the rest of the grammar accepts.
fn handle_arg(args: &Value) -> Result<u64, BridgeError> {
    match args.get("handle") {
        Some(Value::String(text)) => handles::parse_handle_id(text),
        Some(Value::Number(number)) => number.as_u64().ok_or_else(|| {
            BridgeError::InvalidArgs("'handle' must be a handle string or a positive integer".into())
        }),
        _ => Err(BridgeError::InvalidArgs(
            "'handle' is required (for example 'object:3')".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn an_unknown_op_is_rejected_before_the_engine_is_touched() {
        assert_eq!(error_code(object_tool(&json!({ "op": "nope" }), &ctx())), "invalid_args");
    }

    #[test]
    fn op_is_required() {
        assert_eq!(error_code(object_tool(&json!({}), &ctx())), "invalid_args");
    }

    #[test]
    fn release_needs_a_handle() {
        assert_eq!(error_code(object_tool(&json!({ "op": "release" }), &ctx())), "invalid_args");
        assert_eq!(
            error_code(object_tool(&json!({ "op": "release", "handle": "nope" }), &ctx())),
            "invalid_args"
        );
    }

    #[test]
    fn releasing_an_unminted_handle_reports_object_not_found() {
        assert_eq!(
            error_code(object_tool(&json!({ "op": "release", "handle": "object:987654" }), &ctx())),
            "object_not_found"
        );
    }
}
