//! Autoload management (whitepaper section 8 "Project and session").
//! Autoloads live as `autoload/{name}` project settings whose value is the
//! scene or script path, prefixed `*` when enabled. Like the other settings
//! handlers this is a settings-file write, not undo-wrapped: `save()`
//! persists `project.godot` synchronously, and the running editor does not
//! instantiate the singleton; it takes effect in subsequently launched games.

use godot::classes::ProjectSettings;
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_bool, require_str};
use crate::handlers::editor::support::validate_project_path;
use crate::protocol::BridgeError;

const PREFIX: &str = "autoload/";

pub fn autoload(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "list" => list(),
            "add" => add(args),
            "remove" => remove(args),
            other => Err(BridgeError::InvalidArgs(format!("unknown autoload op '{other}'; expected list, add, or remove"))),
        }
    })())
}

/// Split a stored autoload value into its enabled flag and path: a leading
/// `*` marks the singleton enabled.
fn parse_value(stored: &str) -> (bool, &str) {
    match stored.strip_prefix('*') {
        Some(path) => (true, path),
        None => (false, stored),
    }
}

/// An autoload name must be a valid identifier, since it becomes a global
/// script variable in every launched game.
fn validate_name(name: &str) -> Result<(), BridgeError> {
    let mut chars = name.chars();
    let valid_start = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if !valid_start || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(BridgeError::InvalidArgs(format!(
            "autoload name '{name}' must be an identifier (letters, digits, underscores, not starting with a digit)"
        )));
    }
    Ok(())
}

fn list() -> Result<Value, BridgeError> {
    let settings = ProjectSettings::singleton();
    let mut autoloads = Vec::new();
    for entry in settings.get_property_list().iter_shared() {
        let key = entry.get(&GString::from("name")).map(|v| v.to_string()).unwrap_or_default();
        let Some(name) = key.strip_prefix(PREFIX) else { continue };
        let stored = settings.get_setting(key.as_str()).to_string();
        let (enabled, path) = parse_value(&stored);
        autoloads.push(json!({ "name": name, "path": path, "enabled": enabled }));
    }
    Ok(json!({ "autoloads": autoloads }))
}

fn add(args: &Value) -> Result<Value, BridgeError> {
    let name = require_str(args, "name")?;
    let path = require_str(args, "path")?;
    let enabled = optional_bool(args, "enabled").unwrap_or(true);
    validate_name(&name)?;
    validate_project_path(&path)?;

    let key = format!("{PREFIX}{name}");
    let mut settings = ProjectSettings::singleton();
    if settings.has_setting(key.as_str()) {
        return Err(BridgeError::AlreadyExists(format!(
            "autoload '{name}' already exists; remove it first to replace it"
        )));
    }
    let stored = if enabled { format!("*{path}") } else { path.clone() };
    settings.set_setting(key.as_str(), &GString::from(stored.as_str()).to_variant());
    let save_err = settings.save();
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
    }
    Ok(json!({ "name": name, "path": path, "enabled": enabled }))
}

fn remove(args: &Value) -> Result<Value, BridgeError> {
    let name = require_str(args, "name")?;
    let key = format!("{PREFIX}{name}");
    let mut settings = ProjectSettings::singleton();
    if !settings.has_setting(key.as_str()) {
        return Err(BridgeError::InvalidArgs(format!("no autoload named '{name}'")));
    }
    // Setting NIL erases the entry from project.godot.
    settings.set_setting(key.as_str(), &Variant::nil());
    let save_err = settings.save();
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
    }
    Ok(json!({ "name": name, "removed": true }))
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
    fn autoload_requires_op_and_arguments() {
        assert_invalid_args(autoload(&json!({}), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "toggle" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "add" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "add", "name": "Game" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "add", "name": "Game", "path": "/etc/x.gd" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "remove" }), &ctx()));
    }

    #[test]
    fn add_rejects_invalid_identifiers() {
        assert_invalid_args(autoload(&json!({ "op": "add", "name": "9lives", "path": "res://a.gd" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "add", "name": "a-b", "path": "res://a.gd" }), &ctx()));
        assert_invalid_args(autoload(&json!({ "op": "add", "name": "", "path": "res://a.gd" }), &ctx()));
    }

    #[test]
    fn parse_value_splits_the_enabled_marker() {
        assert_eq!(parse_value("*res://game.gd"), (true, "res://game.gd"));
        assert_eq!(parse_value("res://game.gd"), (false, "res://game.gd"));
    }
}
