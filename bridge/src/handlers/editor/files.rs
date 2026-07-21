//! UID-aware file operations (whitepaper section 6.5): move/rename carries
//! the `.uid` sidecar with its source file, matching what the editor does so
//! `uid://` references stay valid; delete removes the file and its
//! `.uid`/`.import` sidecars. Neither is undo-wrapped: physical file
//! operations are not part of the scene undo stack in the real editor either.
//!
//! Dependent-reference reporting (which other resources point at the old
//! path) is not implemented: no reverse-dependency query was found at the
//! `EditorFileSystem`/`EditorInterface` level short of walking
//! `EditorFileSystemDirectory` in more depth than this phase justifies
//! (`docs/api-gaps.md`). `gd_file_move` reports an empty list with a note
//! rather than silently claiming nothing references the old path.

use godot::classes::ProjectSettings;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::args::require_str;
use crate::handlers::editor::support::{trigger_rescan, validate_project_path};
use crate::protocol::BridgeError;

fn globalize(path: &str) -> String {
    ProjectSettings::singleton().globalize_path(path).to_string()
}

pub fn move_file(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String), BridgeError> = (|| {
        let from_path = require_str(args, "from_path")?;
        validate_project_path(&from_path)?;
        let to_path = require_str(args, "to_path")?;
        validate_project_path(&to_path)?;
        Ok((from_path, to_path))
    })();
    let (from_path, to_path) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    let move_result: Result<(), BridgeError> = (|| {
        let from_global = globalize(&from_path);
        let to_global = globalize(&to_path);
        if !std::path::Path::new(&from_global).exists() {
            return Err(BridgeError::ResourceError(format!("no file at '{from_path}'")));
        }
        if std::path::Path::new(&to_global).exists() {
            return Err(BridgeError::AlreadyExists(format!("a file already exists at '{to_path}'")));
        }
        std::fs::rename(&from_global, &to_global)
            .map_err(|e| BridgeError::ResourceError(format!("failed to move '{from_path}' to '{to_path}': {e}")))?;

        let from_uid = format!("{from_global}.uid");
        let to_uid = format!("{to_global}.uid");
        if std::path::Path::new(&from_uid).exists() {
            let _ = std::fs::rename(&from_uid, &to_uid);
        }
        Ok(())
    })();
    if let Err(e) = move_result {
        return HandlerOutcome::Done(Err(e));
    }

    trigger_rescan(false, ctx, move || {
        Ok(json!({
            "from_path": from_path,
            "to_path": to_path,
            "dependents": [],
            "note": "dependent scanning is not implemented; uid:// references remain valid \
                automatically after a move, plain res:// path references are not rewritten",
        }))
    })
}

pub fn delete(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }

    let delete_result: Result<(), BridgeError> = (|| {
        let global_path = globalize(&path);
        if !std::path::Path::new(&global_path).exists() {
            return Err(BridgeError::ResourceError(format!("no file at '{path}'")));
        }
        std::fs::remove_file(&global_path)
            .map_err(|e| BridgeError::ResourceError(format!("failed to delete '{path}': {e}")))?;

        for suffix in [".uid", ".import"] {
            let sidecar = format!("{global_path}{suffix}");
            if std::path::Path::new(&sidecar).exists() {
                let _ = std::fs::remove_file(&sidecar);
            }
        }
        Ok(())
    })();
    if let Err(e) = delete_result {
        return HandlerOutcome::Done(Err(e));
    }

    trigger_rescan(false, ctx, move || Ok(json!({ "path": path, "deleted": true })))
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
    fn move_file_requires_from_path_and_to_path() {
        assert_invalid_args(move_file(&json!({}), &ctx()));
        assert_invalid_args(move_file(&json!({ "from_path": "res://a.tres" }), &ctx()));
    }

    #[test]
    fn move_file_rejects_paths_outside_the_project() {
        assert_invalid_args(move_file(&json!({ "from_path": "/etc/passwd", "to_path": "res://a.tres" }), &ctx()));
        assert_invalid_args(move_file(&json!({ "from_path": "res://a.tres", "to_path": "/etc/passwd" }), &ctx()));
    }

    #[test]
    fn delete_requires_path() {
        assert_invalid_args(delete(&json!({}), &ctx()));
    }

    #[test]
    fn delete_rejects_a_path_outside_the_project() {
        assert_invalid_args(delete(&json!({ "path": "/etc/passwd" }), &ctx()));
    }
}
