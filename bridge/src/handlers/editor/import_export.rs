//! Project export (whitepaper section 8 "Assets and import", phase 4). Drives
//! Godot's own headless export CLI (`--export-pack`, `--export-debug`,
//! `--export-release`) against the project's `export_presets.cfg`.
//!
//! No gdext binding for the export subsystem exists (`docs/api-gaps.md`;
//! Appendix B has no entry for it), and Godot's CLI export flags are
//! themselves the documented, stable, CI-standard mechanism for headless
//! exports -- not a fallback of last resort. This follows the same
//! subprocess + `PendingOp` shape `gd_script_validate` already established
//! (`script.rs`): spawn a fresh, short-lived Godot subprocess, capture its
//! output to a scratch file, and read it back only once `try_wait` confirms
//! the process has exited, so there is no flush-timing question to chase.
//!
//! One thing this subprocess cannot do that the `--check-only` one can: an
//! export CLI invocation runs with editor context, so its own bridge binds
//! an editor-personality listener unconditionally (see the comment at the
//! `CONDUIT_RUNTIME_DIR` override below) -- it is isolated into a private
//! runtime directory rather than prevented, because it cannot be prevented.

use std::path::Path;
use std::process::{Child, Command, Stdio};

use godot::classes::{ConfigFile, Os, ProjectSettings};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_u64, require_str};
use crate::handlers::classdb::paginate;
use crate::handlers::editor::support::validate_project_path;
use crate::protocol::BridgeError;
use crate::variant_json::variant_to_json;

const EXPORT_OUTPUT_MAX_BYTES: usize = 64 * 1024;

// The editor's export subsystem (EditorExportPreset and friends) has no
// scriptable entry point for enumerating presets, so the lister reads
// export_presets.cfg through ConfigFile: Godot's own serialisation of its own
// file, not hand parsing (docs/api-gaps.md).
pub fn export_presets(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let limit = optional_u64(args, "limit").unwrap_or(50);
        let offset = optional_u64(args, "offset").unwrap_or(0);

        let mut config = ConfigFile::new_gd();
        if config.load("res://export_presets.cfg") != godot::global::Error::OK {
            // A project with no presets has no file; that is an empty list.
            return Ok(paginate(Vec::new(), limit, offset));
        }

        let sections: Vec<String> = config.get_sections().as_slice().iter().map(|s| s.to_string()).collect();
        let mut items = Vec::new();
        for section in preset_sections(&sections) {
            let read = |key: &str| -> Value {
                if config.has_section_key(section.as_str(), key) {
                    variant_to_json(&config.get_value(section.as_str(), key))
                } else {
                    Value::Null
                }
            };
            items.push(json!({
                "name": read("name"),
                "platform": read("platform"),
                "runnable": read("runnable"),
                "export_path": read("export_path"),
                "include_filter": read("include_filter"),
                "exclude_filter": read("exclude_filter"),
            }));
        }
        Ok(paginate(items, limit, offset))
    })())
}

// Preset sections are exactly `preset.<digits>`; each preset's option table
// lives in a sibling `preset.<digits>.options` section that must not list.
fn preset_sections(sections: &[String]) -> Vec<String> {
    sections.iter().filter(|s| is_preset_section(s)).cloned().collect()
}

fn is_preset_section(section: &str) -> bool {
    section
        .strip_prefix("preset.")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

pub fn export_project(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String, String, &'static str), BridgeError> = (|| {
        let preset = require_str(args, "preset")?;
        let output_path = require_str(args, "output_path")?;
        validate_project_path(&output_path)?;
        let mode = require_str(args, "mode")?;
        let flag = export_flag(&mode)?;
        Ok((preset, output_path, mode, flag))
    })();

    let (preset, output_path, mode, flag) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    let godot_bin = Os::singleton().get_executable_path().to_string();
    let project_settings = ProjectSettings::singleton();
    let project_path = project_settings.globalize_path("res://").to_string();
    let output_abs = project_settings.globalize_path(output_path.as_str()).to_string();

    // Godot does not create missing intermediate directories for the export
    // output path itself (confirmed empirically: it fails with "Can't open
    // file for writing"), so a first-use output path like `res://export/...`
    // would otherwise always fail.
    if let Err(e) = Path::new(&output_abs).parent().map_or(Ok(()), std::fs::create_dir_all) {
        return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
            "failed to create output directory for '{output_abs}': {e}"
        ))));
    }

    let scratch_path = unique_export_log_path();
    let output_file = match std::fs::File::create(&scratch_path) {
        Ok(f) => f,
        Err(e) => {
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to create scratch file for export logging: {e}"
            ))))
        }
    };
    let stderr_file = match output_file.try_clone() {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_file(&scratch_path);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to prepare scratch file for export logging: {e}"
            ))));
        }
    };

    // Export CLI invocations run with editor context: is_editor_hint() is
    // true even without --editor (confirmed empirically -- the bridge's own
    // "Conduit (editor): listening on ..." log line appears during a bare
    // --export-pack run), and the editor personality's should_bind() returns
    // true unconditionally, ignoring CONDUIT_ENABLE. Stripping CONDUIT_SOCK
    // and CONDUIT_ENABLE alone does NOT stop this subprocess from binding a
    // second editor listener; it only makes it fall back to the same
    // default socket path (derived from CONDUIT_RUNTIME_DIR plus the project
    // path) that a live editor launched without an explicit CONDUIT_SOCK
    // also uses -- confirmed to unlink and steal that live editor's socket
    // out from under it. The fix is not preventing the bind (it cannot be
    // prevented from here) but isolating it: give the subprocess its own
    // private, throwaway CONDUIT_RUNTIME_DIR so whatever it binds can never
    // collide with the parent's.
    let runtime_dir = unique_export_runtime_dir();
    if let Err(e) = std::fs::create_dir_all(&runtime_dir) {
        let _ = std::fs::remove_file(&scratch_path);
        return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
            "failed to create isolated runtime directory for export subprocess: {e}"
        ))));
    }

    let mut command = Command::new(&godot_bin);
    command
        .args(["--headless", "--path", project_path.as_str(), flag, preset.as_str(), output_abs.as_str()])
        .env_remove("CONDUIT_ENABLE")
        .env_remove("CONDUIT_SOCK")
        .env("CONDUIT_RUNTIME_DIR", &runtime_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::from(stderr_file));

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&scratch_path);
            let _ = std::fs::remove_dir_all(&runtime_dir);
            return HandlerOutcome::Done(Err(BridgeError::Internal(format!(
                "failed to spawn godot for project export: {e}"
            ))));
        }
    };

    HandlerOutcome::Pending(Box::new(ExportPending {
        preset,
        mode: mode.to_string(),
        output_path,
        output_abs,
        child,
        scratch_path,
        runtime_dir,
    }))
}

fn export_flag(mode: &str) -> Result<&'static str, BridgeError> {
    match mode {
        "pack" => Ok("--export-pack"),
        "debug" => Ok("--export-debug"),
        "release" => Ok("--export-release"),
        other => {
            Err(BridgeError::InvalidArgs(format!("'mode' must be one of 'pack', 'debug', or 'release'; got '{other}'")))
        }
    }
}

fn unique_export_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("conduit-export-{}-{}.log", std::process::id(), next_export_id()))
}

fn unique_export_runtime_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("conduit-export-runtime-{}-{}", std::process::id(), next_export_id()))
}

fn next_export_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// No dispatcher-side deadline, matching `ScriptCheckPending`: the broker's
/// per-request timeout is the bound on a suspended id's lifetime (whitepaper
/// section 6.4), and `gd_export_project` is registered with a much larger
/// timeout than the default precisely because exports run far longer than
/// most tool calls.
struct ExportPending {
    preset: String,
    mode: String,
    output_path: String,
    output_abs: String,
    child: Child,
    scratch_path: std::path::PathBuf,
    runtime_dir: std::path::PathBuf,
}

impl PendingOp for ExportPending {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) => return None,
            Err(e) => {
                let _ = std::fs::remove_file(&self.scratch_path);
                let _ = std::fs::remove_dir_all(&self.runtime_dir);
                return Some(Err(BridgeError::Internal(format!("failed to wait for export subprocess: {e}"))));
            }
        };

        let mut bytes = std::fs::read(&self.scratch_path).unwrap_or_default();
        let _ = std::fs::remove_file(&self.scratch_path);
        let _ = std::fs::remove_dir_all(&self.runtime_dir);
        if bytes.len() > EXPORT_OUTPUT_MAX_BYTES {
            bytes.drain(0..bytes.len() - EXPORT_OUTPUT_MAX_BYTES);
        }
        let log_tail = String::from_utf8_lossy(&bytes).trim().to_string();

        if !status.success() {
            return Some(Err(BridgeError::ExportFailed(format!(
                "export of preset '{}' (mode: {}) failed: {}",
                self.preset, self.mode, log_tail
            ))));
        }

        let bytes_written = match std::fs::metadata(&self.output_abs) {
            Ok(meta) => meta.len(),
            Err(e) => {
                return Some(Err(BridgeError::ExportFailed(format!(
                    "export of preset '{}' reported success but no artifact was found at '{}': {e}",
                    self.preset, self.output_path
                ))))
            }
        };

        Some(Ok(json!({
            "preset": self.preset,
            "mode": self.mode,
            "path": self.output_path,
            "bytes_written": bytes_written,
        })))
    }
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
    fn export_project_requires_preset() {
        assert_invalid_args(export_project(&json!({ "output_path": "res://export/game.pck", "mode": "pack" }), &ctx()));
    }

    #[test]
    fn export_project_requires_output_path() {
        assert_invalid_args(export_project(&json!({ "preset": "Linux (debug)", "mode": "pack" }), &ctx()));
    }

    #[test]
    fn export_project_requires_mode() {
        assert_invalid_args(export_project(
            &json!({ "preset": "Linux (debug)", "output_path": "res://export/game.pck" }),
            &ctx(),
        ));
    }

    #[test]
    fn export_project_rejects_output_path_outside_project() {
        assert_invalid_args(export_project(
            &json!({ "preset": "Linux (debug)", "output_path": "/tmp/evil.pck", "mode": "pack" }),
            &ctx(),
        ));
    }

    #[test]
    fn export_project_rejects_invalid_mode() {
        assert_invalid_args(export_project(
            &json!({ "preset": "Linux (debug)", "output_path": "res://export/game.pck", "mode": "nonsense" }),
            &ctx(),
        ));
    }

    #[test]
    fn preset_sections_keep_presets_and_drop_option_tables() {
        let sections: Vec<String> = ["preset.0", "preset.0.options", "preset.1", "preset.12", "preset.", "preset.x", "other"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(preset_sections(&sections), vec!["preset.0", "preset.1", "preset.12"]);
    }
}
