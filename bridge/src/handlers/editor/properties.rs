//! Edited-scene node property get and set (whitepaper section 8 "Scene
//! structure"). The setter is undo-wrapped through the property primitive
//! (`add_do_property`/`add_undo_property`), the same shape as node_rename;
//! the getter mirrors the game bridge's `gd_node_get_property` but resolves
//! against the edited scene.

use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::editor::support::{edited_scene_root, relative_path, resolve_editor_node, undo_redo};
use crate::handlers::runtime::support::property_exists;
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

pub fn get_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let property = require_str(args, "property")?;
        let node = resolve_editor_node(&node_path)?;
        let value = node.get(property.as_str());
        if value.is_nil() && !property_exists(&node, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "node '{node_path}' has no property '{property}'"
            )));
        }
        Ok(json!({
            "node_path": node_path,
            "property": property,
            "value": variant_to_json(&value),
        }))
    })())
}

pub fn set_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let property = require_str(args, "property")?;
        let value = args
            .get("value")
            .ok_or_else(|| BridgeError::InvalidArgs("'value' is required".into()))?;

        let node = resolve_editor_node(&node_path)?;
        let root = edited_scene_root()?;
        let previous = node.get(property.as_str());
        if previous.is_nil() && !property_exists(&node, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "node '{node_path}' has no property '{property}'"
            )));
        }

        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Set {property} on {}", node.get_name());
        ur.create_action(action_name.as_str());
        ur.add_do_property(&node, property.as_str(), &variant);
        ur.add_undo_property(&node, property.as_str(), &previous);
        ur.commit_action();

        Ok(json!({
            "node_path": relative_path(&root, &node),
            "property": property,
            "previous": variant_to_json(&previous),
            "action_name": action_name,
        }))
    })())
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
}
