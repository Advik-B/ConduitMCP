//! Resource handlers: create and set-property (whitepaper section 8 "Scripts
//! and resources"). Neither is undo-wrapped: the whitepaper routes resources
//! "through ResourceLoader/ResourceSaver" with no "(undo-wrapped)" qualifier,
//! unlike "Scene structure (editor bridge, undo-wrapped)", and wrapping a
//! property set that is also immediately persisted to disk would let
//! gd_undo revert the in-memory object while the file kept the new value —
//! worse than no undo, since it would misreport what undo accomplished.
//! Mirrors gd_node_set_property's "no undo stack, return previous value"
//! idiom instead.
//!
//! `Object::get_property_list` is only reachable through each concrete
//! class's own generated `Deref` chain, not through a generic bound, so this
//! module keeps small `Gd<Resource>`-scoped property helpers rather than
//! widening `runtime::support`'s `Gd<Node>`-scoped ones.

use godot::builtin::VariantType;
use godot::classes::{ClassDb, Resource, ResourceLoader, ResourceSaver, ResourceUid};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::editor::support::{trigger_rescan, validate_project_path};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed, variant_to_json};

fn resource_property_names(resource: &Gd<Resource>) -> Vec<String> {
    let mut names = Vec::new();
    for entry in resource.get_property_list().iter_shared() {
        let name = entry.get(&GString::from("name")).map(|value| value.to_string()).unwrap_or_default();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

fn resource_property_exists(resource: &Gd<Resource>, name: &str) -> bool {
    resource_property_names(resource).iter().any(|candidate| candidate == name)
}

pub(crate) fn resource_uid_text(path: &str) -> Option<String> {
    let uid = ResourceLoader::singleton().get_resource_uid(path);
    if uid == ResourceUid::INVALID_ID as i64 {
        None
    } else {
        Some(ResourceUid::singleton().id_to_text(uid).to_string())
    }
}

pub fn create(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String), BridgeError> = (|| {
        let class_name = require_str(args, "class_name")?;
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;

        let class_db = ClassDb::singleton();
        if !class_db.class_exists(class_name.as_str()) || !class_db.can_instantiate(class_name.as_str()) {
            return Err(BridgeError::InvalidArgs(format!(
                "'{class_name}' does not exist or cannot be instantiated"
            )));
        }
        if !class_db.is_parent_class(class_name.as_str(), "Resource") {
            return Err(BridgeError::InvalidArgs(format!("'{class_name}' is not a Resource subclass")));
        }
        let resource = class_db
            .instantiate(class_name.as_str())
            .try_to::<Gd<Resource>>()
            .map_err(|e| BridgeError::ResourceError(format!("failed to instantiate '{class_name}': {e}")))?;

        let save_err = ResourceSaver::singleton().save_ex(&resource).path(path.as_str()).done();
        if save_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to save resource to '{path}': {save_err:?}")));
        }
        Ok((path, class_name))
    })();

    let (path, class_name) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    trigger_rescan(false, ctx, move || {
        let uid = resource_uid_text(&path);
        Ok(json!({ "path": path, "class_name": class_name, "uid": uid }))
    })
}

pub fn set_property(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }
    let property = match require_str(args, "property") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    let value = match args.get("value") {
        Some(v) => v.clone(),
        None => return HandlerOutcome::Done(Err(BridgeError::InvalidArgs("'value' is required".into()))),
    };

    let previous_json = match (|| -> Result<Value, BridgeError> {
        let mut resource = ResourceLoader::singleton()
            .load(path.as_str())
            .ok_or_else(|| BridgeError::ResourceError(format!("could not load resource at '{path}'")))?;
        let previous = resource.get(property.as_str());
        if previous.is_nil() && !resource_property_exists(&resource, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "resource at '{path}' has no property '{property}'"
            )));
        }

        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(&value)?
        } else {
            json_to_variant_typed(&value, expected)?
        };
        resource.set(property.as_str(), &variant);

        let save_err = ResourceSaver::singleton().save(&resource);
        if save_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to save resource to '{path}': {save_err:?}")));
        }
        Ok(variant_to_json(&previous))
    })() {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    trigger_rescan(false, ctx, move || Ok(json!({ "path": path, "property": property, "previous": previous_json })))
}

/// Read one property of a resource, or list the properties it has.
///
/// The counterpart `gd_resource_set_property` has always existed, so before
/// this a resource could be written but never read: an agent could set a value
/// and see the previous one come back, and had no way to inspect a `.tres` it
/// had not just written. `op: list` answers the other half, since a resource's
/// property set is not knowable from its class name alone once a script or a
/// sub-resource is involved.
pub fn get_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;

        // Listing is a separate op rather than "property omitted means list" so
        // a typo in the property name cannot silently become a listing. The op
        // and its arguments are settled before the resource is loaded, matching
        // this module's rule that a malformed call costs no engine work.
        let op = args.get("op").and_then(Value::as_str).unwrap_or("get");
        let property = match op {
            "list" => None,
            "get" => Some(require_str(args, "property")?),
            other => {
                return Err(BridgeError::InvalidArgs(format!("unknown op '{other}'; expected get or list")))
            }
        };

        let resource = load_resource(&path)?;
        match property {
            None => Ok(json!({
                "path": path,
                "class_name": resource.get_class().to_string(),
                "properties": resource_property_names(&resource),
            })),
            Some(property) => {
                let value = resource.get(property.as_str());
                if value.is_nil() && !resource_property_exists(&resource, &property) {
                    return Err(BridgeError::InvalidProperty(format!(
                        "resource at '{path}' has no property '{property}'"
                    )));
                }
                Ok(json!({ "path": path, "property": property, "value": variant_to_json(&value) }))
            }
        }
    })())
}

/// Call a method on a resource, optionally re-saving it afterwards.
///
/// Whether a call mutates is not knowable from the method name, so `save` is an
/// explicit argument rather than a guess. It defaults to true because the
/// motivating cases are mutations (`Curve::add_point`, `Gradient::add_point`,
/// `MeshLibrary::create_item`); a pure query passes `save: false` and skips both
/// the write and the rescan.
///
/// Not undo-wrapped, for the reason this module's header already gives.
pub fn call_method(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String, Value, bool), BridgeError> = (|| {
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;
        let method = require_str(args, "method")?;
        let save = args.get("save").and_then(Value::as_bool).unwrap_or(true);

        let mut resource = load_resource(&path)?;
        if !resource.has_method(method.as_str()) {
            return Err(BridgeError::CallFailed(format!(
                "resource at '{path}' has no method '{method}'"
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

        let result = resource.call(method.as_str(), &call_args);
        if save {
            let save_err = ResourceSaver::singleton().save(&resource);
            if save_err != GdError::OK {
                return Err(BridgeError::ResourceError(format!(
                    "failed to save resource to '{path}': {save_err:?}"
                )));
            }
        }
        Ok((path, method, variant_to_json(&result), save))
    })();

    let (path, method, result, save) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    // A pure query changed no file, so there is nothing for the editor to
    // rescan and no reason to make the caller wait for one.
    if !save {
        return HandlerOutcome::Done(Ok(json!({ "path": path, "method": method, "result": result, "saved": false })));
    }
    trigger_rescan(false, ctx, move || {
        Ok(json!({ "path": path, "method": method, "result": result, "saved": true }))
    })
}

fn load_resource(path: &str) -> Result<Gd<Resource>, BridgeError> {
    ResourceLoader::singleton()
        .load(path)
        .ok_or_else(|| BridgeError::ResourceError(format!("could not load resource at '{path}'")))
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
    fn create_requires_class_name_and_path() {
        assert_invalid_args(create(&json!({}), &ctx()));
        assert_invalid_args(create(&json!({ "class_name": "Resource" }), &ctx()));
        assert_invalid_args(create(&json!({ "class_name": "Resource", "path": "/tmp/evil.tres" }), &ctx()));
    }

    #[test]
    fn get_property_validates_before_touching_the_engine() {
        assert_invalid_args(get_property(&json!({}), &ctx()));
        assert_invalid_args(get_property(&json!({ "path": "/tmp/evil.tres", "property": "x" }), &ctx()));
        assert_invalid_args(get_property(&json!({ "path": "res://x.tres", "op": "nope" }), &ctx()));
    }

    #[test]
    fn call_method_requires_a_path_and_a_method() {
        assert_invalid_args(call_method(&json!({}), &ctx()));
        assert_invalid_args(call_method(&json!({ "path": "res://x.tres" }), &ctx()));
        assert_invalid_args(call_method(&json!({ "path": "/tmp/evil.tres", "method": "add_point" }), &ctx()));
    }

    #[test]
    fn set_property_requires_path_property_and_value() {
        assert_invalid_args(set_property(&json!({}), &ctx()));
        assert_invalid_args(set_property(&json!({ "path": "res://x.tres" }), &ctx()));
        assert_invalid_args(set_property(&json!({ "path": "res://x.tres", "property": "resource_name" }), &ctx()));
        assert_invalid_args(set_property(
            &json!({ "path": "/tmp/evil.tres", "property": "resource_name", "value": "x" }),
            &ctx(),
        ));
    }
}
