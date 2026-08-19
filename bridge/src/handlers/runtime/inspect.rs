//! Read-only runtime inspection handlers (whitepaper section 6.6).

use godot::classes::Node;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    object_method_names, object_property_exists, object_property_names, object_signal_names,
    optional_str, optional_u64, require_str, resolve_node, resolve_target, scene_tree,
    variant_type_name,
};
use crate::handlers::target::{target_response, target_spec, TargetSpec};
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

const DEFAULT_TREE_DEPTH: u64 = 3;

/// Read a single property, converting the Variant to tagged JSON.
pub fn get_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let property = require_str(args, "property")?;
        let object = resolve_target(&spec)?;
        let value = object.get(property.as_str());
        if value.is_nil() && !object_property_exists(&object, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "{} has no property '{property}'",
                spec.label()
            )));
        }
        Ok(target_response(
            &spec,
            json!({
                "property": property,
                "type": variant_type_name(&value),
                "value": variant_to_json(&value),
            }),
        ))
    })())
}

/// Report a node's class, children, property names, signals, and methods.
pub fn get_info(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let object = resolve_target(&spec)?;

        let mut fields = json!({
            "class": object.get_class().to_string(),
            "properties": object_property_names(&object),
            "signals": object_signal_names(&object),
            "methods": object_method_names(&object),
        });

        // Children and a tree path only mean something for a node; a singleton
        // has neither, and inventing empty ones would read as "it has no
        // children" rather than "the question does not apply".
        if let TargetSpec::Node(path) = &spec {
            let node = resolve_node(path)?;
            let children: Vec<Value> = node
                .get_children()
                .iter_shared()
                .map(|child| node_summary(&child))
                .collect();
            fields["name"] = json!(node.get_name().to_string());
            fields["path"] = json!(node.get_path().to_string());
            fields["child_count"] = json!(node.get_child_count());
            fields["children"] = Value::Array(children);
        }

        Ok(target_response(&spec, fields))
    })())
}

/// Dump the scene tree from a root, depth-limited so a large scene does not
/// flood the agent's context (whitepaper section 7.6).
pub fn get_tree(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let max_depth = optional_u64(args, "max_depth").unwrap_or(DEFAULT_TREE_DEPTH);
        let root = match optional_str(args, "root_path") {
            Some(path) => resolve_node(&path)?,
            None => scene_tree()?
                .get_current_scene()
                .ok_or_else(|| BridgeError::NodeNotFound("no current scene is running".into()))?,
        };
        Ok(json!({ "tree": tree_node(&root, max_depth) }))
    })())
}

fn node_summary(node: &Gd<Node>) -> Value {
    json!({
        "name": node.get_name().to_string(),
        "class": node.get_class().to_string(),
        "path": node.get_path().to_string(),
    })
}

fn tree_node(node: &Gd<Node>, depth_remaining: u64) -> Value {
    let mut entry = json!({
        "name": node.get_name().to_string(),
        "class": node.get_class().to_string(),
        "path": node.get_path().to_string(),
        "child_count": node.get_child_count(),
    });
    if depth_remaining > 0 {
        let children: Vec<Value> = node
            .get_children()
            .iter_shared()
            .map(|child| tree_node(&child, depth_remaining - 1))
            .collect();
        entry["children"] = Value::Array(children);
    } else if node.get_child_count() > 0 {
        entry["children_truncated"] = json!(true);
    }
    entry
}
