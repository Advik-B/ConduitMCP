//! Script handlers: create, attach, detach, and validate (whitepaper
//! section 8 "Scripts and resources"). Attach/detach are undo-wrapped through
//! the same `add_do_property`/`add_undo_property` mechanism as
//! `gd_node_rename`, since `script` is a regular dynamic property from the
//! undo manager's perspective, not a distinct method call (`docs/api-gaps.md`:
//! `Object` has no public `set_script`/`get_script` bound as callable methods
//! by name for the varcall path the undo manager would need anyway). Create is
//! a file-creation handler, not undo-wrapped, mirroring `gd_resource_create`.

use std::process::{Child, Command, Stdio};

use godot::classes::{GDScript, Os, ProjectSettings, ResourceLoader, ResourceSaver, Script};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_str, require_str};
use crate::handlers::editor::support::{resolve_editor_node, trigger_rescan, undo_redo, validate_project_path};
use crate::protocol::BridgeError;

const VALIDATE_OUTPUT_MAX_BYTES: usize = 64 * 1024;

pub fn create(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String), BridgeError> = (|| {
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;
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
        validate_project_path(&script_path)?;

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

/// Validates by parsing `path` in a fresh, short-lived Godot subprocess
/// (`--check-only --script`) rather than reloading it in this long-running
/// editor process and tailing its own log file. The live editor's log writer
/// buffers output and only flushes on buffer-fill or process exit, never on a
/// bounded wait: waiting several real seconds (confirmed both by dispatcher
/// frame count and by a genuine `std::time::Instant` deadline) still saw zero
/// new bytes for a diagnostic that a separate process could read moments
/// later (`docs/api-gaps.md`). A subprocess sidesteps this entirely — all of
/// its own buffers are flushed as a consequence of exiting, which we detect
/// deterministically via `try_wait`, and `--check-only` is built for exactly
/// this: parse-only, no scene or game execution.
pub fn validate(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }

    let godot_bin = Os::singleton().get_executable_path().to_string();
    let project_path = ProjectSettings::singleton().globalize_path("res://").to_string();
    let output_path = unique_check_output_path();

    let output_file = match std::fs::File::create(&output_path) {
        Ok(f) => f,
        Err(e) => {
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to create scratch file for script validation: {e}"
            ))))
        }
    };
    let stderr_file = match output_file.try_clone() {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&output_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to prepare scratch file for script validation: {e}"
            ))));
        }
    };

    let mut command = Command::new(&godot_bin);
    command
        .args(["--headless", "--path", project_path.as_str(), "--script", path.as_str(), "--check-only"])
        // Never let the checked-out subprocess's own GDExtension init try to
        // bind a bridge socket; it inherits these otherwise (whitepaper
        // section 6.3's opt-in gate covers the non-editor case, but clearing
        // them here means the gate is never even consulted).
        .env_remove("CONDUIT_ENABLE")
        .env_remove("CONDUIT_SOCK")
        .env_remove("CONDUIT_RUNTIME_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::from(stderr_file));

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&output_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to spawn godot for script validation: {e}"
            ))));
        }
    };

    HandlerOutcome::Pending(Box::new(ScriptCheckPending { path, child, output_path }))
}

fn unique_check_output_path() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("conduit-script-check-{}-{n}.log", std::process::id()))
}

struct ScriptCheckPending {
    path: String,
    child: Child,
    output_path: std::path::PathBuf,
}

impl PendingOp for ScriptCheckPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) => return None,
            Err(e) => {
                let _ = std::fs::remove_file(&self.output_path);
                return Some(Err(BridgeError::Internal(format!(
                    "failed to wait for script validation subprocess: {e}"
                ))));
            }
        };

        let mut bytes = std::fs::read(&self.output_path).unwrap_or_default();
        let _ = std::fs::remove_file(&self.output_path);

        if status.success() {
            return Some(Ok(json!({ "path": self.path, "valid": true, "diagnostics": [] })));
        }

        if bytes.len() > VALIDATE_OUTPUT_MAX_BYTES {
            bytes.drain(0..bytes.len() - VALIDATE_OUTPUT_MAX_BYTES);
        }
        let text = String::from_utf8_lossy(&bytes);
        let diagnostics = extract_diagnostics(&text, &self.path);
        Some(Ok(json!({ "path": self.path, "valid": false, "diagnostics": diagnostics })))
    }
}

/// Best-effort diagnostic extraction from the engine log's error output
/// around a reload. Godot typically emits a message line ("SCRIPT ERROR:
/// Parse Error: ...") followed by one or more "   at: <fn> (<path>:<line>)"
/// continuation lines; this pairs each message with the line number from the
/// first continuation line naming the validated script, if any.
fn extract_diagnostics(log_text: &str, path: &str) -> Vec<Value> {
    let lines: Vec<&str> = log_text.lines().collect();
    let mut diagnostics = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let is_continuation = line.trim_start().starts_with("at:");
        if is_continuation || !line.to_ascii_lowercase().contains("error") {
            i += 1;
            continue;
        }

        let mut line_number = None;
        let mut next = i + 1;
        while next < lines.len() && lines[next].trim_start().starts_with("at:") {
            if let Some(n) = line_number_after_path(lines[next], path) {
                line_number = Some(n);
                break;
            }
            next += 1;
        }
        diagnostics.push(json!({ "line": line_number, "message": line.trim() }));
        i = next.max(i + 1);
    }
    diagnostics
}

fn line_number_after_path(line: &str, path: &str) -> Option<u64> {
    let start = line.find(path)?;
    let after = line[start + path.len()..].strip_prefix(':')?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok()
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
    fn create_rejects_a_path_outside_the_project() {
        assert_invalid_args(create(&json!({ "path": "/tmp/evil.gd" }), &ctx()));
    }

    #[test]
    fn attach_requires_node_path_and_script_path() {
        assert_invalid_args(attach(&json!({}), &ctx()));
        assert_invalid_args(attach(&json!({ "node_path": "Player" }), &ctx()));
        assert_invalid_args(attach(&json!({ "node_path": "Player", "script_path": "/tmp/evil.gd" }), &ctx()));
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
    fn validate_rejects_a_path_outside_the_project() {
        assert_invalid_args(validate(&json!({ "path": "/tmp/evil.gd" }), &ctx()));
    }

    #[test]
    fn extract_diagnostics_pairs_message_with_line_from_at_continuation() {
        // The real format Godot 4.7 emits for a GDScript parse error.
        let log = "SCRIPT ERROR: Parse Error: Expected parameter name.\n   at: GDScript::reload (res://broken.gd:2)\n";
        let diagnostics = extract_diagnostics(log, "res://broken.gd");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0]["line"], 2);
        assert!(diagnostics[0]["message"].as_str().unwrap().contains("Parse Error"));
    }

    #[test]
    fn extract_diagnostics_handles_multiple_errors_and_a_leading_load_failure() {
        let log = concat!(
            "SCRIPT ERROR: Parse Error: Expected parameter name.\n",
            "   at: GDScript::reload (res://broken.gd:2)\n",
            "ERROR: Failed to load script \"res://broken.gd\" with error \"Parse error\".\n",
            "   at: load (modules/gdscript/gdscript_resource_format.cpp:46)\n",
        );
        let diagnostics = extract_diagnostics(log, "res://broken.gd");
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0]["line"], 2);
        // The second error's "at:" line does not mention the script path, so
        // no line number is attributed to it.
        assert!(diagnostics[1]["line"].is_null());
    }

    #[test]
    fn extract_diagnostics_falls_back_to_null_line_when_no_at_continuation_names_the_path() {
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
