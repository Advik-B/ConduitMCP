//! Script handlers: create, attach, detach, and validate (whitepaper
//! section 8 "Scripts and resources"). Attach/detach are undo-wrapped through
//! the same `add_do_property`/`add_undo_property` mechanism as
//! `gd_node_rename`, since `script` is a regular dynamic property from the
//! undo manager's perspective, not a distinct method call (`docs/api-gaps.md`:
//! `Object` has no public `set_script`/`get_script` bound as callable methods
//! by name for the varcall path the undo manager would need anyway). Create is
//! a file-creation handler, not undo-wrapped, mirroring `gd_resource_create`.

use godot::classes::{GDScript, ResourceLoader, ResourceSaver, Script};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::{optional_str, require_str};
use crate::handlers::editor::support::{resolve_editor_node, trigger_rescan, undo_redo};
use crate::log_tail;
use crate::protocol::BridgeError;

const VALIDATE_LOG_MAX_BYTES: usize = 64 * 1024;

pub fn create(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String), BridgeError> = (|| {
        let path = require_str(args, "path")?;
        let extends = optional_str(args, "extends").unwrap_or_else(|| "Node".to_string());
        let template_source = optional_str(args, "template_source");
        // Never validated here: a broken template_source is exactly how
        // gd_script_validate's diagnostics path gets exercised, so this
        // handler's only job is writing bytes faithfully.
        let source = template_source.unwrap_or_else(|| format!("extends {extends}\n"));

        let mut script = GDScript::new_gd();
        script.set_source_code(source.as_str());
        let save_err = ResourceSaver::singleton().save_ex(&script).path(path.as_str()).done();
        if save_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to save script to '{path}': {save_err:?}")));
        }
        Ok((path, extends))
    })();

    let (path, extends) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    trigger_rescan(false, ctx, move || Ok(json!({ "path": path, "extends": extends })))
}

pub fn attach(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let script_path = require_str(args, "script_path")?;

        let node = resolve_editor_node(&node_path)?;
        let resource = ResourceLoader::singleton()
            .load(script_path.as_str())
            .ok_or_else(|| BridgeError::ResourceError(format!("could not load resource at '{script_path}'")))?;
        let script = resource
            .try_cast::<Script>()
            .map_err(|_| BridgeError::InvalidArgs(format!("'{script_path}' is not a Script resource")))?;

        let old_script = node.get_script().map(|s| s.to_variant()).unwrap_or(Variant::nil());
        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Attach {script_path} to {}", node.get_name());
        ur.create_action(action_name.as_str());
        ur.add_do_property(&node, "script", &script.to_variant());
        ur.add_undo_property(&node, "script", &old_script);
        ur.commit_action();

        Ok(json!({ "node_path": node_path, "script_path": script_path, "action_name": action_name }))
    })())
}

pub fn detach(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let node = resolve_editor_node(&node_path)?;
        let old_script = node.get_script().map(|s| s.to_variant()).unwrap_or(Variant::nil());

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Detach script from {}", node.get_name());
        ur.create_action(action_name.as_str());
        ur.add_do_property(&node, "script", &Variant::nil());
        ur.add_undo_property(&node, "script", &old_script);
        ur.commit_action();

        Ok(json!({ "node_path": node_path, "action_name": action_name }))
    })())
}

pub fn validate(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let path = require_str(args, "path")?;

        // Local, freshly-captured offset: this must not share the game
        // bridge's incremental log cursor, and must not accumulate across
        // separate gd_script_validate calls.
        let log_path = log_tail::log_file_path();
        let start_offset = log_path
            .as_deref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);

        let loaded = ResourceLoader::singleton()
            .load_ex(path.as_str())
            .cache_mode(godot::classes::resource_loader::CacheMode::REPLACE)
            .done();

        let valid = match loaded.map(|r| r.try_cast::<Script>()) {
            Some(Ok(mut script)) => script.reload() == GdError::OK,
            _ => false,
        };

        let diagnostics = if valid {
            Vec::new()
        } else {
            let text = log_path
                .as_deref()
                .map(|p| log_tail::read_log_range(p, start_offset, VALIDATE_LOG_MAX_BYTES).0)
                .unwrap_or_default();
            extract_diagnostics(&text, &path)
        };

        Ok(json!({ "path": path, "valid": valid, "diagnostics": diagnostics }))
    })())
}

/// Best-effort line-number extraction from the engine log's error output
/// around a reload, matching lines that mention the script's path (typically
/// `res://foo.gd:12 - Parse Error: ...`) or otherwise look like an error.
fn extract_diagnostics(log_text: &str, path: &str) -> Vec<Value> {
    let mut diagnostics = Vec::new();
    for line in log_text.lines() {
        let mentions_path = line.contains(path);
        if !mentions_path && !line.to_ascii_lowercase().contains("error") {
            continue;
        }
        let line_number = mentions_path
            .then(|| line.find(path))
            .flatten()
            .and_then(|start| line[start + path.len()..].strip_prefix(':'))
            .and_then(|after| {
                let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().ok()
            });
        diagnostics.push(json!({ "line": line_number, "message": line.trim() }));
    }
    diagnostics
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
    fn create_requires_path() {
        assert_invalid_args(create(&json!({}), &ctx()));
    }

    #[test]
    fn attach_requires_node_path_and_script_path() {
        assert_invalid_args(attach(&json!({}), &ctx()));
        assert_invalid_args(attach(&json!({ "node_path": "Player" }), &ctx()));
    }

    #[test]
    fn detach_requires_node_path() {
        assert_invalid_args(detach(&json!({}), &ctx()));
    }

    #[test]
    fn validate_requires_path() {
        assert_invalid_args(validate(&json!({}), &ctx()));
    }

    #[test]
    fn extract_diagnostics_finds_line_number_after_path() {
        let log = "some unrelated line\nres://broken.gd:2 - Parse Error: Expected \")\"\nanother line";
        let diagnostics = extract_diagnostics(log, "res://broken.gd");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0]["line"], 2);
        assert!(diagnostics[0]["message"].as_str().unwrap().contains("Parse Error"));
    }

    #[test]
    fn extract_diagnostics_falls_back_to_null_line_for_generic_error_lines() {
        let log = "SCRIPT ERROR: something went wrong";
        let diagnostics = extract_diagnostics(log, "res://broken.gd");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0]["line"].is_null());
    }

    #[test]
    fn extract_diagnostics_ignores_unrelated_lines() {
        let log = "Godot Engine v4.7.1\nready.";
        assert!(extract_diagnostics(log, "res://broken.gd").is_empty());
    }
}
