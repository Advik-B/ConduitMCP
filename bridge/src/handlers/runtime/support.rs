//! Shared helpers for the game-bridge runtime handlers.
//!
//! Everything here runs on the main thread inside `_process`, so it reaches the
//! engine through global singletons rather than a plumbed-in handle. Node lookup
//! is by absolute scene path (whitepaper section 6.6); a miss reports the nearest
//! existing ancestor, matching the section 7.4 error example.

use godot::builtin::VariantType;
use godot::classes::{Engine, Node, SceneTree, Window};
use godot::prelude::*;
use serde_json::{Map, Value};

use crate::handlers::target::{resolve_singleton, TargetSpec};
use crate::protocol::BridgeError;
use crate::variant_json::{json_to_variant, json_to_variant_typed};

pub use crate::handlers::args::{
    optional_bool, optional_f64, optional_str, optional_u64, require_f64, require_str,
};

pub fn scene_tree() -> Result<Gd<SceneTree>, BridgeError> {
    Engine::singleton()
        .get_main_loop()
        .and_then(|main_loop| main_loop.try_cast::<SceneTree>().ok())
        .ok_or_else(|| BridgeError::Internal("no running SceneTree on this bridge".into()))
}

pub fn scene_root() -> Result<Gd<Window>, BridgeError> {
    scene_tree()?
        .get_root()
        .ok_or_else(|| BridgeError::Internal("scene tree has no root window".into()))
}

/// Resolve an absolute node path (for example `/root/Main/Player`) to a node.
pub fn resolve_node(path: &str) -> Result<Gd<Node>, BridgeError> {
    let root = scene_root()?;
    match root.get_node_or_null(path) {
        Some(node) => Ok(node),
        None => Err(BridgeError::NodeNotFound(nearest_ancestor_message(&root, path))),
    }
}

/// Resolve a target on the game bridge: a node by absolute scene path, or an
/// engine singleton. The singleton arm is what makes `RenderingServer`, `OS`,
/// `Time`, and every other server addressable without `gd_game_eval`. The
/// object arm resolves a handle held by this process (`crate::handles`), which
/// is what reaches objects with no name at all.
pub fn resolve_target(spec: &TargetSpec) -> Result<Gd<Object>, BridgeError> {
    match spec {
        TargetSpec::Node(path) => Ok(resolve_node(path)?.upcast()),
        TargetSpec::Singleton(name) => resolve_singleton(name),
        TargetSpec::Object(id) => crate::handles::resolve(*id),
    }
}

fn nearest_ancestor_message(root: &Gd<Window>, path: &str) -> String {
    let segments: Vec<&str> =
        path.trim_start_matches('/').split('/').filter(|segment| !segment.is_empty()).collect();
    let mut nearest = "/root".to_string();
    for end in (1..segments.len()).rev() {
        let prefix = format!("/{}", segments[..end].join("/"));
        if root.get_node_or_null(prefix.as_str()).is_some() {
            nearest = prefix;
            break;
        }
    }
    format!("No node at path {path}. Nearest existing ancestor: {nearest}.")
}

/// Apply a JSON map of property values to any engine object, coercing each
/// value toward the property's current type as `gd_node_set_property` does.
/// Unknown properties fail the whole call before any write happens.
pub fn apply_properties(
    object: &mut Gd<Object>,
    properties: &Map<String, Value>,
) -> Result<Vec<String>, BridgeError> {
    let mut writes = Vec::with_capacity(properties.len());
    for (name, value) in properties {
        let previous = object.get(name.as_str());
        if previous.is_nil() && !object_property_exists(object, name) {
            return Err(BridgeError::InvalidProperty(format!(
                "{} has no property '{name}'",
                object.get_class()
            )));
        }
        let variant = if previous.get_type() == VariantType::NIL {
            json_to_variant(value)?
        } else {
            json_to_variant_typed(value, previous.get_type())?
        };
        writes.push((name.clone(), variant));
    }
    let mut applied = Vec::with_capacity(writes.len());
    for (name, variant) in writes {
        object.set(name.as_str(), &variant);
        applied.push(name);
    }
    Ok(applied)
}

/// The optional `properties` argument as an object map.
pub fn optional_properties(args: &Value) -> Result<Option<&Map<String, Value>>, BridgeError> {
    match args.get("properties") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(BridgeError::InvalidArgs("'properties' must be an object map".into())),
    }
}

pub fn object_property_exists(object: &Gd<Object>, name: &str) -> bool {
    object.get_property_list().iter_shared().any(|entry| {
        entry.get(&GString::from("name")).map(|value| value.to_string()).as_deref() == Some(name)
    })
}

fn names_from(list: Array<VarDictionary>) -> Vec<String> {
    let mut names = Vec::new();
    for entry in list.iter_shared() {
        let name = entry.get(&GString::from("name")).map(|value| value.to_string()).unwrap_or_default();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

/// The declared property names of any engine object, in `get_property_list`
/// order. Object-scoped rather than Node-scoped so a singleton answers too.
pub fn object_property_names(object: &Gd<Object>) -> Vec<String> {
    names_from(object.get_property_list())
}

/// The method names any engine object responds to.
pub fn object_method_names(object: &Gd<Object>) -> Vec<String> {
    names_from(object.get_method_list())
}

/// The signal names any engine object declares.
pub fn object_signal_names(object: &Gd<Object>) -> Vec<String> {
    names_from(object.get_signal_list())
}

/// A readable name for a Variant type, for example `VECTOR2` or `INT`.
pub fn variant_type_name(variant: &Variant) -> String {
    format!("{:?}", variant.get_type())
}

/// The declared property names of a node, in `get_property_list` order.
pub fn property_names(node: &Gd<Node>) -> Vec<String> {
    object_property_names(&node.clone().upcast())
}

pub fn property_exists(node: &Gd<Node>, name: &str) -> bool {
    object_property_exists(&node.clone().upcast(), name)
}

/// The method names a node responds to.
pub fn method_names(node: &Gd<Node>) -> Vec<String> {
    object_method_names(&node.clone().upcast())
}

/// The signal names a node declares.
pub fn signal_names(node: &Gd<Node>) -> Vec<String> {
    object_signal_names(&node.clone().upcast())
}

