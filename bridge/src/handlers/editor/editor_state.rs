//! Undo/redo and editor-state handlers (whitepaper sections 6.5 and 8).
//!
//! `EditorUndoRedoManager` itself has no `undo()`/`redo()` (`docs/api-gaps.md`):
//! those live on the plain `UndoRedo` returned by
//! `get_history_undo_redo(get_object_history_id(...))`. Every mutation this
//! phase records targets a node in the edited scene, so that scene's history
//! is the only one `gd_undo`/`gd_redo` need to reach.

use godot::classes::{Control, EditorInterface};
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
            "main_screen": current_main_screen(&editor),
            "playing": editor.is_playing_scene(),
            "breakpoints": crate::debugger::breakpoints_json(),
            "debug": { "sessions": crate::debugger::sessions_json() },
        }))
    })
}

/// Best-effort name of the currently visible main-screen editor (2D, 3D, Script,
/// Game, AssetLib). The editor exposes no direct getter (`docs/api-gaps.md`), so
/// this reports the visible child of the main-screen container by class, mapped
/// to the canonical name where recognized.
fn current_main_screen(editor: &Gd<EditorInterface>) -> Value {
    let Some(container) = editor.get_editor_main_screen() else {
        return Value::Null;
    };
    for child in container.get_children().iter_shared() {
        let visible = child.clone().try_cast::<Control>().map(|c| c.is_visible()).unwrap_or(false);
        if visible {
            // Since 4.3 a main-screen editor may be nested in a WindowWrapper
            // (for the make-floating feature), so map from the first known editor
            // class in the visible subtree rather than the wrapper's own class.
            let class = main_screen_class(&child).unwrap_or_else(|| child.get_class().to_string());
            let name = match class.as_str() {
                "CanvasItemEditor" => "2D",
                "Node3DEditor" => "3D",
                "ScriptEditor" => "Script",
                "GameView" => "Game",
                "EditorAssetLibrary" => "AssetLib",
                other => other,
            };
            return Value::String(name.to_string());
        }
    }
    Value::Null
}

/// The first known main-screen editor class in `node`'s subtree (including
/// `node` itself), unwrapping the WindowWrapper indirection.
fn main_screen_class(node: &Gd<Node>) -> Option<String> {
    const KNOWN: [&str; 5] = ["CanvasItemEditor", "Node3DEditor", "ScriptEditor", "GameView", "EditorAssetLibrary"];
    let class = node.get_class().to_string();
    if KNOWN.contains(&class.as_str()) {
        return Some(class);
    }
    for child in node.get_children().iter_shared() {
        if let Some(found) = main_screen_class(&child) {
            return Some(found);
        }
    }
    None
}
