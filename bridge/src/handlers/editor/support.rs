//! Shared helpers for the editor-bridge handlers: resolving nodes within the
//! *edited* scene (as opposed to the live `SceneTree` the game bridge walks),
//! reaching the undo/redo manager, owner bookkeeping for created nodes, and the
//! non-blocking filesystem-rescan wait every file-creating handler needs
//! (whitepaper sections 6.5 and 6.6).

use godot::classes::{EditorInterface, EditorUndoRedoManager, Node};
use godot::prelude::*;
use serde_json::Value;

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::target::{resolve_singleton, TargetSpec};
use crate::protocol::BridgeError;

/// Frames to wait for `EditorFileSystem` to finish scanning before giving up.
/// Import can be slow for large or many assets; this is generous on purpose.
const RESCAN_DEADLINE_FRAMES: u64 = 1200;

/// Confine a resource/file path to the project (`res://`) or user
/// (`user://`) directory and reject traversal segments, so a handler cannot
/// be pointed outside the project (whitepaper section 9).
pub(crate) fn validate_project_path(path: &str) -> Result<(), BridgeError> {
    if !path.starts_with("res://") && !path.starts_with("user://") {
        return Err(BridgeError::InvalidArgs(format!("path '{path}' must start with res:// or user://")));
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err(BridgeError::InvalidArgs(format!("path '{path}' must not contain '..' segments")));
    }
    Ok(())
}

/// The root of the scene currently open for editing. Every scene-structure
/// handler needs one; there is nothing sensible to do without it.
pub(crate) fn edited_scene_root() -> Result<Gd<Node>, BridgeError> {
    EditorInterface::singleton()
        .get_edited_scene_root()
        .ok_or_else(|| BridgeError::NoEditedScene("no scene is open for editing; call gd_scene_open first".into()))
}

/// Resolve a node path relative to the edited scene's root (`.` addresses the
/// root itself, matching Godot's `NodePath` self-reference convention). On a
/// miss, reports the nearest existing ancestor, mirroring
/// `runtime::support::resolve_node`'s error shape (whitepaper section 7.4).
pub(crate) fn resolve_editor_node(path: &str) -> Result<Gd<Node>, BridgeError> {
    let root = edited_scene_root()?;
    match root.get_node_or_null(path) {
        Some(node) => Ok(node),
        None => Err(BridgeError::NodeNotFound(nearest_ancestor_message(&root, path))),
    }
}

/// Resolve a target on the editor bridge: a node in the *edited scene*, or an
/// engine singleton. The singleton arm reaches `EditorInterface`,
/// `ProjectSettings`, `EditorFileSystem`, and the servers without
/// `gd_editor_eval`, which matters more here than on the game bridge because
/// editor eval is off unless explicitly enabled. The object arm resolves a
/// handle held by this process (`crate::handles`).
pub(crate) fn resolve_editor_target(spec: &TargetSpec) -> Result<Gd<Object>, BridgeError> {
    match spec {
        TargetSpec::Node(path) => Ok(resolve_editor_node(path)?.upcast()),
        TargetSpec::Singleton(name) => resolve_singleton(name),
        TargetSpec::Object(id) => crate::handles::resolve(*id),
    }
}

fn nearest_ancestor_message(root: &Gd<Node>, path: &str) -> String {
    if path == "." || path.is_empty() {
        return format!("No node at path '{path}' under the edited scene root.");
    }
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    let mut nearest = ".".to_string();
    for end in (1..segments.len()).rev() {
        let prefix = segments[..end].join("/");
        if root.get_node_or_null(prefix.as_str()).is_some() {
            nearest = prefix;
            break;
        }
    }
    format!("No node at path '{path}' in the edited scene. Nearest existing ancestor: '{nearest}'.")
}

/// A node's path relative to `root`, self-computed by walking parents rather
/// than trusting `Node::get_path()`, which resolves against whatever tree the
/// node happens to be inside and is not guaranteed to match the edited
/// scene's root the way the game bridge's live `SceneTree` root always does.
/// `.` addresses `root` itself, matching Godot's `NodePath` self-reference and
/// what `resolve_editor_node` accepts back as input, so reported paths
/// round-trip directly into later calls.
pub(crate) fn relative_path(root: &Gd<Node>, node: &Gd<Node>) -> String {
    if node == root {
        return ".".to_string();
    }
    let mut segments = Vec::new();
    let mut current = node.clone();
    loop {
        segments.push(current.get_name().to_string());
        match current.get_parent() {
            Some(parent) if &parent == root => break,
            Some(parent) => current = parent,
            None => break,
        }
    }
    segments.reverse();
    segments.join("/")
}

/// The editor's undo/redo manager. Every scene-structure and script-attach
/// mutation is recorded here (whitepaper section 6.5).
pub(crate) fn undo_redo() -> Result<Gd<EditorUndoRedoManager>, BridgeError> {
    EditorInterface::singleton()
        .get_editor_undo_redo()
        .ok_or_else(|| BridgeError::Internal("no EditorUndoRedoManager available".into()))
}

/// Queue `add_do_property(descendant, "owner", owner)` for `node` and every
/// descendant, so a node created or duplicated in one undo action persists on
/// save (whitepaper section 6.5's ownership rule). Godot's own Add Node and
/// Duplicate actions do the same for the same reason.
pub(crate) fn queue_owner_recursive(ur: &mut Gd<EditorUndoRedoManager>, node: &Gd<Node>, owner: &Gd<Node>) {
    for child in node.get_children().iter_shared() {
        ur.add_do_property(&child, "owner", &owner.to_variant());
        queue_owner_recursive(ur, &child, owner);
    }
}

/// A filesystem rescan is asynchronous; polling `is_scanning()` from the frame
/// after submission (never the same frame, matching the `WaitFrames`/
/// `ScreenshotPending` idiom) avoids both a premature-settle race and
/// re-entering the dispatcher the way a blocking call would (`docs/api-gaps.md`).
struct RescanPending<F: FnOnce() -> Result<Value, BridgeError>> {
    deadline_frame: u64,
    finish: Option<F>,
}

impl<F: FnOnce() -> Result<Value, BridgeError>> PendingOp for RescanPending<F> {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        let still_scanning = EditorInterface::singleton()
            .get_resource_filesystem()
            .map(|fs| fs.is_scanning())
            .unwrap_or(false);
        if !still_scanning {
            let finish = self.finish.take().expect("RescanPending polled again after settling");
            return Some(finish());
        }
        if ctx.frame_index >= self.deadline_frame {
            return Some(Err(BridgeError::Internal("filesystem scan did not settle before the deadline".into())));
        }
        None
    }
}

/// Trigger a non-blocking filesystem rescan (`scan()` for new/moved/deleted
/// files, `scan_sources()` for changed import sources) and defer `finish`
/// until it settles. `finish` runs on the main thread once scanning is done,
/// so it may safely read back import results (a UID, a resource type). Never
/// use `EditorFileSystem::reimport_files`, which is documented to block and
/// pump the main loop (`docs/api-gaps.md`).
pub(crate) fn trigger_rescan<F>(sources_only: bool, ctx: &FrameContext, finish: F) -> HandlerOutcome
where
    F: FnOnce() -> Result<Value, BridgeError> + 'static,
{
    let Some(mut fs) = EditorInterface::singleton().get_resource_filesystem() else {
        return HandlerOutcome::Done(Err(BridgeError::Internal("no EditorFileSystem available".into())));
    };
    if sources_only {
        fs.scan_sources();
    } else {
        fs.scan();
    }
    HandlerOutcome::Pending(Box::new(RescanPending {
        deadline_frame: ctx.frame_index.saturating_add(RESCAN_DEADLINE_FRAMES),
        finish: Some(finish),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_project_path_accepts_res_and_user_scheme() {
        assert!(validate_project_path("res://scenes/main.tscn").is_ok());
        assert!(validate_project_path("user://save.dat").is_ok());
    }

    #[test]
    fn validate_project_path_rejects_paths_outside_the_project() {
        assert_eq!(validate_project_path("/etc/passwd").unwrap_err().code(), "invalid_args");
        assert_eq!(validate_project_path("C:\\Windows\\system.ini").unwrap_err().code(), "invalid_args");
        assert!(validate_project_path("scenes/main.tscn").is_err());
    }

    #[test]
    fn validate_project_path_rejects_traversal_segments() {
        assert!(validate_project_path("res://../outside.tres").is_err());
        assert!(validate_project_path("res://a/../../b.tres").is_err());
    }
}
