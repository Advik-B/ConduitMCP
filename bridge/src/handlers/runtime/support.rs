//! Shared helpers for the game-bridge runtime handlers.
//!
//! Everything here runs on the main thread inside `_process`, so it reaches the
//! engine through global singletons rather than a plumbed-in handle. Node lookup
//! is by absolute scene path (whitepaper section 6.6); a miss reports the nearest
//! existing ancestor, matching the section 7.4 error example.

use godot::classes::{Engine, Node, SceneTree, Window};
use godot::prelude::*;
use serde_json::Value;

use crate::protocol::BridgeError;

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

/// A readable name for a Variant type, for example `VECTOR2` or `INT`.
pub fn variant_type_name(variant: &Variant) -> String {
    format!("{:?}", variant.get_type())
}

/// The declared property names of a node, in `get_property_list` order.
pub fn property_names(node: &Gd<Node>) -> Vec<String> {
    let mut names = Vec::new();
    for entry in node.get_property_list().iter_shared() {
        let name = entry.get(&GString::from("name")).map(|value| value.to_string()).unwrap_or_default();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

pub fn property_exists(node: &Gd<Node>, name: &str) -> bool {
    property_names(node).iter().any(|candidate| candidate == name)
}

/// The method names a node responds to.
pub fn method_names(node: &Gd<Node>) -> Vec<String> {
    let mut names = Vec::new();
    for entry in node.get_method_list().iter_shared() {
        let name = entry.get(&GString::from("name")).map(|value| value.to_string()).unwrap_or_default();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

/// The signal names a node declares.
pub fn signal_names(node: &Gd<Node>) -> Vec<String> {
    let mut names = Vec::new();
    for entry in node.get_signal_list().iter_shared() {
        let name = entry.get(&GString::from("name")).map(|value| value.to_string()).unwrap_or_default();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

pub fn require_str(args: &Value, key: &str) -> Result<String, BridgeError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| BridgeError::InvalidArgs(format!("'{key}' is required and must be a string")))
}

pub fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}
