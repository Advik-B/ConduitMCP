//! Edited-scene property get and set, plus the edited-scene method call
//! (whitepaper section 8 "Scene structure"). The setter is undo-wrapped through
//! the property primitive (`add_do_property`/`add_undo_property`), the same
//! shape as node_rename; the getter mirrors the game bridge's
//! `gd_node_get_property` but resolves against the edited scene.
//!
//! All three accept the `target` grammar, so `singleton:ProjectSettings` and
//! `singleton:EditorInterface` are reachable here without `gd_editor_eval` --
//! which matters more on this bridge than on the game one, because editor eval
//! is off unless explicitly enabled.

use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::editor::support::{
    edited_scene_root, relative_path, resolve_editor_node, resolve_editor_target, undo_redo,
};
use crate::handlers::runtime::support::object_property_exists;
use crate::handlers::target::{target_response, target_spec, TargetSpec};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

pub fn get_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let property = require_str(args, "property")?;
        let object = resolve_editor_target(&spec)?;
        let value = object.get(property.as_str());
        if value.is_nil() && !object_property_exists(&object, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "'{}' has no property '{property}'",
                spec.label()
            )));
        }
        let mut response = canonicalise(
            &spec,
            target_response(&spec, json!({ "property": property, "value": variant_to_json(&value) })),
        )?;
        crate::handles::apply_capture(args, &value, &mut response)?;
        Ok(response)
    })())
}

pub fn set_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let property = require_str(args, "property")?;
        let value = args
            .get("value")
            .ok_or_else(|| BridgeError::InvalidArgs("'value' is required".into()))?;

        let mut object = resolve_editor_target(&spec)?;
        let previous = object.get(property.as_str());
        if previous.is_nil() && !object_property_exists(&object, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "'{}' has no property '{property}'",
                spec.label()
            )));
        }

        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };

        // Only a node in the edited scene belongs on the editor's undo stack.
        // A singleton write is engine-global state, not scene state: putting it
        // on the scene history would let gd_undo claim to revert something the
        // history never owned, so it is applied directly and reported as not
        // undoable rather than pretending otherwise. A handle-named object is
        // the same case for the same reason: it is not part of the edited
        // scene, so the scene history cannot own a write to it.
        let action_name = match &spec {
            TargetSpec::Node(path) => {
                let node = resolve_editor_node(path)?;
                let name = format!("Conduit: Set {property} on {}", node.get_name());
                let mut ur = undo_redo()?;
                ur.create_action(name.as_str());
                ur.add_do_property(&node, property.as_str(), &variant);
                ur.add_undo_property(&node, property.as_str(), &previous);
                ur.commit_action();
                Some(name)
            }
            TargetSpec::Singleton(_) | TargetSpec::Object(_) => {
                object.set(property.as_str(), &variant);
                None
            }
        };

        canonicalise(
            &spec,
            target_response(
                &spec,
                json!({
                    "property": property,
                    "previous": variant_to_json(&previous),
                    "action_name": action_name,
                    "undoable": action_name.is_some(),
                }),
            ),
        )
    })())
}

/// Call a method on a node in the edited scene, or on a singleton.
///
/// **Deliberately not undo-wrapped.** `EditorUndoRedoManager` records a
/// mutation as a do/undo pair, and an arbitrary method call has no inverse:
/// there is no undo for `set_cell` or `bake_navigation_mesh`. Wrapping the call
/// as `add_do_method` with no meaningful undo half would put an entry on the
/// history that `gd_undo` cannot honour, so `gd_undo` would report success
/// while restoring nothing. `editor/resource.rs` makes the same argument for
/// the same reason: a misreporting undo is worse than no undo.
///
/// The consequence is the caller's to manage. A call that mutates the edited
/// scene leaves it dirty and needs `gd_scene_save`, and it cannot be rolled
/// back; the tool description says so, and the response says `undoable: false`
/// so the property and method paths can be told apart programmatically.
pub fn call_method(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let method = require_str(args, "method")?;
        let mut object = resolve_editor_target(&spec)?;
        if !object.has_method(method.as_str()) {
            return Err(BridgeError::CallFailed(format!(
                "'{}' has no method '{method}'",
                spec.label()
            )));
        }

        let call_args = match args.get("args") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .map(json_to_variant)
                .collect::<Result<Vec<Variant>, BridgeError>>()?,
            Some(_) => return Err(BridgeError::InvalidArgs("'args' must be an array".into())),
        };

        let result = object.call(method.as_str(), &call_args);
        let mut response = canonicalise(
            &spec,
            target_response(
                &spec,
                json!({ "method": method, "result": variant_to_json(&result), "undoable": false }),
            ),
        )?;
        crate::handles::apply_capture(args, &result, &mut response)?;
        Ok(response)
    })())
}

/// Replace the echoed `node_path` with the edited scene's canonical relative
/// path, which is what these handlers reported before the target grammar and
/// what `resolve_editor_node` accepts back verbatim on the next call.
fn canonicalise(spec: &TargetSpec, mut response: Value) -> Result<Value, BridgeError> {
    if let TargetSpec::Node(path) = spec {
        let node = resolve_editor_node(path)?;
        let root = edited_scene_root()?;
        response["node_path"] = json!(relative_path(&root, &node));
    }
    Ok(response)
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
    fn get_property_requires_node_path_and_property() {
        assert_invalid_args(get_property(&json!({}), &ctx()));
        assert_invalid_args(get_property(&json!({ "node_path": "Player" }), &ctx()));
    }

    #[test]
    fn set_property_requires_node_path_property_and_value() {
        assert_invalid_args(set_property(&json!({}), &ctx()));
        assert_invalid_args(set_property(&json!({ "node_path": "Player" }), &ctx()));
        assert_invalid_args(set_property(&json!({ "node_path": "Player", "property": "position" }), &ctx()));
    }

    #[test]
    fn call_method_requires_a_target_and_a_method() {
        assert_invalid_args(call_method(&json!({}), &ctx()));
        assert_invalid_args(call_method(&json!({ "node_path": "TileMapLayer" }), &ctx()));
        assert_invalid_args(call_method(&json!({ "method": "set_cell" }), &ctx()));
    }

    #[test]
    fn passing_both_target_and_node_path_is_rejected_before_any_engine_call() {
        assert_invalid_args(call_method(
            &json!({ "target": "singleton:OS", "node_path": "Player", "method": "get_name" }),
            &ctx(),
        ));
        assert_invalid_args(get_property(
            &json!({ "target": "singleton:OS", "node_path": "Player", "property": "x" }),
            &ctx(),
        ));
        assert_invalid_args(set_property(
            &json!({ "target": "singleton:OS", "node_path": "Player", "property": "x", "value": 1 }),
            &ctx(),
        ));
    }
}
