//! The target grammar: how a tool call names the object it acts on.
//!
//! Before this existed, every generic tool took `node_path` and resolved it
//! through the scene tree, so anything that is not a node in a tree -- every
//! singleton, every server -- was reachable only through `gd_game_eval`. One
//! optional `target` argument replaces that, and it is deliberately parsed in
//! exactly one place: four tools on two bridges share it, and four grammars
//! that drift apart would be worse than the gap it closes.
//!
//! `node_path` still works and means exactly what it always did. `target` is
//! additive, so no existing call, test, or eval snippet changes behaviour.
//!
//! Parsing is engine-free and unit-tested here; resolution touches the engine
//! and lives with the bridge that owns the tree (`runtime::support` walks the
//! live `SceneTree`, `editor::support` walks the edited scene).

use godot::classes::Engine;
use godot::prelude::*;
use serde_json::Value;

use crate::handlers::args::optional_str;
use crate::protocol::BridgeError;

/// The `singleton:` scheme is a prefix rather than a separate argument so the
/// grammar stays one string, which is what keeps the schema one field.
const SINGLETON_PREFIX: &str = "singleton:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetSpec {
    /// A node path, interpreted by whichever bridge resolves it.
    Node(String),
    /// An engine singleton by class name, for example `OS` or `RenderingServer`.
    Singleton(String),
}

impl TargetSpec {
    /// How the target should read back in a response or an error.
    pub fn label(&self) -> String {
        match self {
            TargetSpec::Node(path) => path.clone(),
            TargetSpec::Singleton(name) => format!("{SINGLETON_PREFIX}{name}"),
        }
    }
}

/// Parse a `target` string. Anything without a recognised scheme prefix is a
/// node path, which is what makes the grammar backward compatible: the old
/// argument's values are a subset of the new argument's.
pub fn parse_target(target: &str) -> Result<TargetSpec, BridgeError> {
    if let Some(name) = target.strip_prefix(SINGLETON_PREFIX) {
        let name = name.trim();
        if name.is_empty() {
            return Err(BridgeError::InvalidArgs(
                "'target' singleton name is empty; expected for example 'singleton:OS'".into(),
            ));
        }
        return Ok(TargetSpec::Singleton(name.to_string()));
    }
    if target.trim().is_empty() {
        return Err(BridgeError::InvalidArgs("'target' must not be empty".into()));
    }
    Ok(TargetSpec::Node(target.to_string()))
}

/// Read whichever of `target` and `node_path` the caller supplied.
///
/// Supplying both is rejected rather than silently preferring one: they can
/// disagree, and a call that means two different things is a bug the agent
/// should hear about immediately.
pub fn target_spec(args: &Value) -> Result<TargetSpec, BridgeError> {
    let target = optional_str(args, "target");
    let node_path = optional_str(args, "node_path");
    match (target, node_path) {
        (Some(_), Some(_)) => Err(BridgeError::InvalidArgs(
            "pass either 'target' or 'node_path', not both".into(),
        )),
        (Some(target), None) => parse_target(&target),
        (None, Some(path)) => Ok(TargetSpec::Node(path)),
        (None, None) => Err(BridgeError::InvalidArgs(
            "'target' is required (a node path, or 'singleton:<Class>')".into(),
        )),
    }
}

/// Build a response that names the target it acted on.
///
/// `node_path` is echoed back for node targets so every response written before
/// `target` existed keeps its shape; callers that never learn the new grammar
/// see no change at all.
pub fn target_response(spec: &TargetSpec, fields: Value) -> Value {
    let mut map = match fields {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    map.insert("target".to_string(), Value::String(spec.label()));
    if let TargetSpec::Node(path) = spec {
        map.insert("node_path".to_string(), Value::String(path.clone()));
    }
    Value::Object(map)
}

/// Resolve a singleton by class name. Identical on both bridges, so it lives
/// here rather than being duplicated into each one's support module.
///
/// `Engine::get_singleton_list()` is the engine's own answer to what exists,
/// and it is what the not-found error quotes: the documentation's singleton
/// list and the running engine's can differ (editor-only singletons, the
/// `*Manager` classes), and the running engine is the one that matters.
pub fn resolve_singleton(name: &str) -> Result<Gd<Object>, BridgeError> {
    let engine = Engine::singleton();
    if let Some(object) = engine.get_singleton(name) {
        return Ok(object);
    }
    let mut known: Vec<String> = engine.get_singleton_list().as_slice().iter().map(|s| s.to_string()).collect();
    known.sort();
    Err(BridgeError::NodeNotFound(format!(
        "no singleton named '{name}'. Available: {}.",
        known.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bare_path_is_a_node_target() {
        assert_eq!(parse_target("/root/Main/Player").unwrap(), TargetSpec::Node("/root/Main/Player".into()));
        assert_eq!(parse_target("Player/Sprite2D").unwrap(), TargetSpec::Node("Player/Sprite2D".into()));
        assert_eq!(parse_target(".").unwrap(), TargetSpec::Node(".".into()));
    }

    #[test]
    fn the_singleton_scheme_is_recognised_and_trimmed() {
        assert_eq!(parse_target("singleton:OS").unwrap(), TargetSpec::Singleton("OS".into()));
        assert_eq!(parse_target("singleton: RenderingServer ").unwrap(), TargetSpec::Singleton("RenderingServer".into()));
    }

    #[test]
    fn empty_targets_are_rejected() {
        assert_eq!(parse_target("singleton:").unwrap_err().code(), "invalid_args");
        assert_eq!(parse_target("   ").unwrap_err().code(), "invalid_args");
    }

    #[test]
    fn node_path_still_works_and_means_a_node() {
        let args = json!({ "node_path": "/root/Main" });
        assert_eq!(target_spec(&args).unwrap(), TargetSpec::Node("/root/Main".into()));
    }

    #[test]
    fn target_supersedes_nothing_and_conflicts_are_errors() {
        let both = json!({ "target": "singleton:OS", "node_path": "/root/Main" });
        assert_eq!(target_spec(&both).unwrap_err().code(), "invalid_args");
        let neither = json!({ "method": "get_name" });
        assert_eq!(target_spec(&neither).unwrap_err().code(), "invalid_args");
    }

    #[test]
    fn responses_echo_node_path_for_node_targets_only() {
        let node = target_response(&TargetSpec::Node("/root/Main".into()), json!({ "property": "name" }));
        assert_eq!(node["node_path"], json!("/root/Main"));
        assert_eq!(node["target"], json!("/root/Main"));
        let singleton = target_response(&TargetSpec::Singleton("OS".into()), json!({ "property": "name" }));
        assert_eq!(singleton["target"], json!("singleton:OS"));
        assert!(singleton.get("node_path").is_none());
    }

    #[test]
    fn labels_round_trip_back_into_the_grammar() {
        for text in ["/root/Main/Player", "singleton:OS"] {
            assert_eq!(parse_target(&parse_target(text).unwrap().label()).unwrap(), parse_target(text).unwrap());
        }
    }
}
