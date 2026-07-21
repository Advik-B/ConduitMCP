//! Undo/redo and editor-state handlers (whitepaper sections 6.5 and 8).
//!
//! `EditorUndoRedoManager` itself has no `undo()`/`redo()` (`docs/api-gaps.md`):
//! those live on the plain `UndoRedo` returned by
//! `get_history_undo_redo(get_object_history_id(...))`. Every mutation this
//! phase records targets a node in the edited scene, so that scene's history
//! is the only one `gd_undo`/`gd_redo` need to reach.

use godot::classes::EditorInterface;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::editor::support::{edited_scene_root, undo_redo};
use crate::protocol::BridgeError;

pub fn undo(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(step(false))
}

pub fn redo(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(step(true))
}

/// Shared undo/redo sequence. "Nothing to undo/redo" (no edited scene, or an
/// empty history) is a valid `performed: false` outcome, not an error — only
/// scene-structure mutations treat a missing edited scene as a hard failure.
fn step(is_redo: bool) -> Result<Value, BridgeError> {
    let Ok(root) = edited_scene_root() else {
        return Ok(json!({ "performed": false, "action_name": null }));
    };
    let ur = undo_redo()?;
    let history_id = ur.get_object_history_id(&root);
    let mut history = ur
        .get_history_undo_redo(history_id)
        .ok_or_else(|| BridgeError::Internal("no undo history for the edited scene".into()))?;

    let available = if is_redo { history.has_redo() } else { history.has_undo() };
    if !available {
        return Ok(json!({ "performed": false, "action_name": null }));
    }
    let action_name = history.get_current_action_name().to_string();
    let performed = if is_redo { history.redo() } else { history.undo() };
    Ok(json!({
        "performed": performed,
        "action_name": if performed { Value::String(action_name) } else { Value::Null },
    }))
}

pub fn get_state(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done({
        let editor = EditorInterface::singleton();
        let open_paths = editor.get_open_scenes();
        let open_roots = editor.get_open_scene_roots();
        let edited_root = editor.get_edited_scene_root();

        let mut scenes = Vec::new();
        let mut current_scene = None;
        for (index, root) in open_roots.iter_shared().enumerate() {
            let path = open_paths.get(index).map(|p| p.to_string()).unwrap_or_default();
            let dirty = editor.is_object_edited(&root);
            if edited_root.as_ref() == Some(&root) {
                current_scene = Some(path.clone());
            }
            scenes.push(json!({ "path": path, "dirty": dirty }));
        }

        let selection: Vec<String> = editor
            .get_selection()
            .map(|selection| {
                selection
                    .get_selected_nodes()
                    .iter_shared()
                    .map(|node| node.get_name().to_string())
                    .collect()
            })
            .unwrap_or_default();

        Ok(json!({
            "open_scenes": scenes,
            "current_scene": current_scene,
            "selection": selection,
            "playing": editor.is_playing_scene(),
        }))
    })
}
