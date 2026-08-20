//! Editor plugin enable and disable (whitepaper section 8 "Project and
//! session"). A plugin is a directory under `res://addons` holding a
//! `plugin.cfg`, and the engine names one by that directory rather than by the
//! path to its config file, so that is the only spelling this tool accepts.
//!
//! Not undo-wrapped, for the reason the other settings handlers give: the
//! enabled set lives in `editor_plugins/enabled` in `project.godot` and
//! `ProjectSettings::save()` persists it synchronously, so putting the change
//! on the edited scene's history would let `gd_undo` claim to revert something
//! the history never owned. Unlike `gd_autoload`, this one does take effect in
//! the running editor immediately: enabling instantiates the plugin script and
//! runs its `_enter_tree`.

use godot::classes::{ConfigFile, DirAccess, EditorInterface, FileAccess, ProjectSettings};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

const ADDONS_DIR: &str = "res://addons";
const PLUGIN_SECTION: &str = "plugin";

pub fn editor_plugin(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let op = require_str(args, "op")?;
        match op.as_str() {
            "list" => list(),
            "enable" => set_enabled(args, true),
            "disable" => set_enabled(args, false),
            other => Err(BridgeError::InvalidArgs(format!(
                "unknown editor_plugin op '{other}'; expected list, enable, or disable"
            ))),
        }
    })())
}

/// The engine documents the plugin argument as the directory name under
/// `res://addons`. Rejecting anything path-shaped keeps one spelling rather
/// than silently accepting both a name and a `res://` config path, and a name
/// with no separator and no `..` cannot address anything outside `addons/`.
fn validate_plugin_name(name: &str) -> Result<(), BridgeError> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err(BridgeError::InvalidArgs(format!(
            "plugin '{name}' must be a directory name under res://addons, not a path"
        )));
    }
    Ok(())
}

fn plugin_config_path(name: &str) -> String {
    format!("{ADDONS_DIR}/{name}/plugin.cfg")
}

fn list() -> Result<Value, BridgeError> {
    let editor = EditorInterface::singleton();
    let mut plugins = Vec::new();
    if DirAccess::dir_exists_absolute(ADDONS_DIR) {
        for entry in DirAccess::get_directories_at(ADDONS_DIR).as_slice() {
            let name = entry.to_string();
            let config_path = plugin_config_path(&name);
            let mut config = ConfigFile::new_gd();
            // A directory under addons/ without a plugin.cfg is not a plugin:
            // a GDExtension addon (Conduit's own, for one) lives there too.
            if config.load(config_path.as_str()) != GdError::OK {
                continue;
            }
            let read = |key: &str| -> Value {
                if config.has_section_key(PLUGIN_SECTION, key) {
                    variant_to_json(&config.get_value(PLUGIN_SECTION, key))
                } else {
                    Value::Null
                }
            };
            plugins.push(json!({
                "plugin": name,
                "config_path": config_path,
                "name": read("name"),
                "description": read("description"),
                "author": read("author"),
                "version": read("version"),
                "script": read("script"),
                "enabled": editor.is_plugin_enabled(name.as_str()),
            }));
        }
    }
    Ok(json!({ "plugins": plugins }))
}

fn set_enabled(args: &Value, enabled: bool) -> Result<Value, BridgeError> {
    let name = require_str(args, "plugin")?;
    validate_plugin_name(&name)?;

    let config_path = plugin_config_path(&name);
    if !FileAccess::file_exists(config_path.as_str()) {
        return Err(BridgeError::ResourceError(format!(
            "no plugin at '{config_path}'; the plugin argument is a directory name under res://addons, and gd_editor_plugin list reports the ones that exist"
        )));
    }

    let mut editor = EditorInterface::singleton();
    let previous = editor.is_plugin_enabled(name.as_str());
    editor.set_plugin_enabled(name.as_str(), enabled);

    // set_plugin_enabled reports nothing. A plugin whose script fails to load
    // leaves the enabled set unchanged, so reading it back is the only way to
    // tell a refusal from a success.
    let observed = editor.is_plugin_enabled(name.as_str());
    if observed != enabled {
        let verb = if enabled { "enable" } else { "disable" };
        return Err(BridgeError::ResourceError(format!(
            "the editor did not {verb} plugin '{name}'; its plugin script probably failed to load, which the editor log records"
        )));
    }

    // The engine updates editor_plugins/enabled in memory; the save is what
    // puts it in project.godot. Saving unconditionally is idempotent, so
    // whether the engine already saved does not have to be known.
    let mut settings = ProjectSettings::singleton();
    let save_err = settings.save();
    if save_err != GdError::OK {
        return Err(BridgeError::ResourceError(format!("failed to save project settings: {save_err:?}")));
    }

    Ok(json!({ "plugin": name, "enabled": enabled, "previous": previous }))
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
    fn editor_plugin_requires_op_and_arguments() {
        assert_invalid_args(editor_plugin(&json!({}), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "toggle" }), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "enable" }), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "disable" }), &ctx()));
    }

    #[test]
    fn plugin_names_are_directories_not_paths() {
        assert_invalid_args(editor_plugin(&json!({ "op": "enable", "plugin": "" }), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "enable", "plugin": "res://addons/x/plugin.cfg" }), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "enable", "plugin": "x/plugin.cfg" }), &ctx()));
        assert_invalid_args(editor_plugin(&json!({ "op": "enable", "plugin": "../secrets" }), &ctx()));
        assert!(validate_plugin_name("phase15_marker").is_ok());
    }

    #[test]
    fn config_path_is_the_directory_plus_plugin_cfg() {
        assert_eq!(plugin_config_path("conduit"), "res://addons/conduit/plugin.cfg");
    }
}
