//! Runtime mutation handlers: property writes, method calls, and live tree
//! mutation (section 6.6). Tree mutation is the runtime companion of
//! `gd_tree_get`: it works on the running scene directly, with no undo layer.

use godot::builtin::VariantType;
use godot::classes::{ClassDb, PackedScene, ResourceLoader};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::{
    apply_properties, object_property_exists, optional_bool, optional_properties, optional_str,
    require_str, resolve_node, resolve_target, scene_root, scene_tree,
};
use crate::handlers::target::{target_response, target_spec, TargetSpec};
use crate::protocol::BridgeError;
use crate::variant_json::{
    json_to_variant, json_to_variant_typed, validate_resource_path, variant_to_json,
};

/// Set a property, coercing the value toward the property's current type and
/// returning the previous value so the write is reversible by the agent.
pub fn set_property(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let property = require_str(args, "property")?;
        let value = args
            .get("value")
            .ok_or_else(|| BridgeError::InvalidArgs("'value' is required".into()))?;

        let mut object = resolve_target(&spec)?;
        let previous = object.get(property.as_str());
        if previous.is_nil() && !object_property_exists(&object, &property) {
            return Err(BridgeError::InvalidProperty(format!(
                "{} has no property '{property}'",
                spec.label()
            )));
        }

        let expected = previous.get_type();
        let variant = if expected == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, expected)?
        };

        object.set(property.as_str(), &variant);
        Ok(target_response(
            &spec,
            json!({ "property": property, "previous": variant_to_json(&previous) }),
        ))
    })())
}

/// Call a method with converted arguments and return its result.
pub fn call_method(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let spec = target_spec(args)?;
        let method = require_str(args, "method")?;
        let call_args = crate::handlers::call::call_args(args)?;

        // A class target has no receiver, so it takes the static door instead
        // of being resolved to an object. Everything after the call is shared:
        // the same response shape, and the same capture, which is what turns
        // FileAccess.open into an object handle the next call can name.
        let result = if let TargetSpec::Class(class) = &spec {
            crate::handlers::call::call_static(class, &method, &call_args)?
        } else {
            let mut object = resolve_target(&spec)?;
            if !object.has_method(method.as_str()) {
                return Err(BridgeError::CallFailed(format!(
                    "{} has no method '{method}'",
                    spec.label()
                )));
            }
            crate::handlers::call::call_on(&mut object, &method, &call_args)?
        };
        let mut response =
            target_response(&spec, json!({ "method": method, "result": variant_to_json(&result) }));
        crate::handles::apply_capture(args, &result, &mut response)?;
        Ok(response)
    })())
}

/// Live tree mutation behind an op discriminator: instantiate a packed scene,
/// create a raw node by class, queue-free a node, reparent, or change the
/// current scene (section 8 "Runtime mutation").
pub fn tree_mutate(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "instantiate" => instantiate(args),
            "add_node" => add_node(args),
            "free" => free(args),
            "reparent" => reparent(args),
            "change_scene" => change_scene(args),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown op '{other}'; expected instantiate, add_node, free, reparent, or change_scene"
            ))),
        }
    })())
}

fn instantiate(args: &Value) -> Result<Value, BridgeError> {
    let scene_path = require_str(args, "scene_path")?;
    let parent_path = require_str(args, "parent_path")?;
    validate_resource_path(&scene_path)?;

    let mut parent = resolve_node(&parent_path)?;
    let packed = ResourceLoader::singleton()
        .load(scene_path.as_str())
        .and_then(|res| res.try_cast::<PackedScene>().ok())
        .ok_or_else(|| {
            BridgeError::ResourceError(format!("'{scene_path}' is not a loadable PackedScene"))
        })?;
    let mut instance = packed.instantiate().ok_or_else(|| {
        BridgeError::ResourceError(format!("failed to instantiate '{scene_path}'"))
    })?;
    if let Some(name) = optional_str(args, "name") {
        instance.set_name(name.as_str());
    }
    if let Some(properties) = optional_properties(args)? {
        let mut object = instance.clone().upcast::<Object>();
        apply_properties(&mut object, properties)?;
    }
    parent.add_child(&instance);
    Ok(json!({
        "node_path": instance.get_path().to_string(),
        "name": instance.get_name().to_string(),
        "class": instance.get_class().to_string(),
        "scene_path": scene_path,
    }))
}

// Raw node creation by engine class closes runtime setup of joints, collision
// shapes, lights, cameras, and audio players without a dedicated tool each.
fn add_node(args: &Value) -> Result<Value, BridgeError> {
    let class = require_str(args, "class")?;
    let parent_path = require_str(args, "parent_path")?;

    let db = ClassDb::singleton();
    if !db.class_exists(class.as_str()) {
        return Err(BridgeError::InvalidArgs(format!(
            "class '{class}' does not exist in this engine build"
        )));
    }
    if !db.is_parent_class(class.as_str(), "Node") {
        return Err(BridgeError::InvalidArgs(format!("class '{class}' is not a Node type")));
    }
    if !db.can_instantiate(class.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("class '{class}' cannot be instantiated")));
    }

    let mut parent = resolve_node(&parent_path)?;
    let mut node = db
        .instantiate(class.as_str())
        .try_to::<Gd<Node>>()
        .map_err(|_| BridgeError::CallFailed(format!("failed to instantiate '{class}'")))?;
    if let Some(name) = optional_str(args, "name") {
        node.set_name(name.as_str());
    }
    if let Some(properties) = optional_properties(args)? {
        let mut object = node.clone().upcast::<Object>();
        if let Err(error) = apply_properties(&mut object, properties) {
            node.queue_free();
            return Err(error);
        }
    }
    parent.add_child(&node);
    Ok(json!({
        "node_path": node.get_path().to_string(),
        "name": node.get_name().to_string(),
        "class": node.get_class().to_string(),
    }))
}

// queue_free is the safe primitive while a `_process`-driven handler holds the
// tree: the node persists until end of frame, which the result says.
fn free(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let mut node = resolve_node(&node_path)?;
    if node == scene_root()?.upcast::<Node>() {
        return Err(BridgeError::InvalidArgs("cannot free the root window".into()));
    }
    node.queue_free();
    Ok(json!({ "queued": true, "node_path": node_path }))
}

fn reparent(args: &Value) -> Result<Value, BridgeError> {
    let node_path = require_str(args, "node_path")?;
    let new_parent_path = require_str(args, "new_parent_path")?;
    let keep_global_transform = optional_bool(args, "keep_global_transform").unwrap_or(true);

    let mut node = resolve_node(&node_path)?;
    let new_parent = resolve_node(&new_parent_path)?;
    if node == scene_root()?.upcast::<Node>() {
        return Err(BridgeError::InvalidArgs("cannot reparent the root window".into()));
    }
    if node == new_parent || node.is_ancestor_of(&new_parent) {
        return Err(BridgeError::InvalidArgs(format!(
            "cannot reparent {node_path} under its own subtree at {new_parent_path}"
        )));
    }
    node.reparent_ex(&new_parent).keep_global_transform(keep_global_transform).done();
    Ok(json!({
        "node_path": node.get_path().to_string(),
        "name": node.get_name().to_string(),
    }))
}

// The switch is deferred by the engine to end of frame; callers should
// gd_wait_frames before touching paths under the old scene.
fn change_scene(args: &Value) -> Result<Value, BridgeError> {
    let scene_path = require_str(args, "scene_path")?;
    validate_resource_path(&scene_path)?;
    let error = scene_tree()?.change_scene_to_file(scene_path.as_str());
    if error != godot::global::Error::OK {
        return Err(BridgeError::ResourceError(format!(
            "change_scene to '{scene_path}' failed: {error:?}"
        )));
    }
    Ok(json!({ "requested": true, "scene_path": scene_path }))
}
