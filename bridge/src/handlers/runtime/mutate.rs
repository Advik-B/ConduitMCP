//! Runtime mutation handlers: property writes and method calls (section 6.6).

use godot::builtin::VariantType;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{property_exists, require_str, resolve_node};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

/// Set a property, coercing the value toward the property's current type and
/// returning the previous value so the write is reversible by the agent.
pub fn set_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let property = require_str(args, "property")?;
        let value = args
            .get("value")
            .ok_or_else(|| BridgeError::InvalidArgs("'value' is required".into()))?;

        let mut node = resolve_node(&node_path)?;
        let previous = node.get(property.as_str());
        if previous.is_nil() && !property_exists(&node, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "node {node_path} has no property '{property}'"
            )));
        }

        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };

        node.set(property.as_str(), &variant);
        Ok(json!({
            "node_path": node_path,
            "property": property,
            "previous": variant_to_json(&previous),
        }))
    })())
}

/// Call a method with converted arguments and return its result.
pub fn call_method(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let method = require_str(args, "method")?;
        let mut node = resolve_node(&node_path)?;
        if !node.has_method(method.as_str()) {
            return Err(BridgeError::CallFailed(format!(
                "node {node_path} has no method '{method}'"
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

        let result = node.call(method.as_str(), &call_args);
        Ok(json!({
            "node_path": node_path,
            "method": method,
            "result": variant_to_json(&result),
        }))
    })())
}
