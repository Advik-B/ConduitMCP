//! Scene-structure handlers: open, create, read, save, and the node
//! operations, every mutation routed through `EditorUndoRedoManager` so it is
//! undo-safe and keeps the live editor consistent (whitepaper section 6.5).
//!
//! `try_add_do_method`/`try_add_undo_method` are used throughout rather than
//! their panicking counterparts (`docs/api-gaps.md`). Node-creating handlers
//! (`add`, `duplicate`) follow the same do/undo/reference shape: add the node,
//! set its owner (recursively over any pre-existing children), reference it so
//! it survives if "do" history is discarded before ever being undone, and undo
//! by removing it.

use godot::classes::{ClassDb, EditorInterface, Node, PackedScene, ResourceSaver};
use godot::global::Error as GdError;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_bool, optional_str, optional_u64, require_str};
use crate::handlers::editor::support::{
    edited_scene_root, relative_path, resolve_editor_node, trigger_rescan, undo_redo, validate_project_path,
};
use crate::protocol::BridgeError;

const DEFAULT_TREE_DEPTH: u64 = 3;

fn call_error(action: &str, err: godot::meta::error::CallError) -> BridgeError {
    BridgeError::Internal(format!("{action} failed: {err}"))
}

/// Instantiate `type_name` as a `Node` subclass, validated first so a bad
/// class name fails with `invalid_args` rather than an obscure cast error.
fn instantiate_node(type_name: &str) -> Result<Gd<Node>, BridgeError> {
    let class_db = ClassDb::singleton();
    if !class_db.class_exists(type_name) || !class_db.can_instantiate(type_name) {
        return Err(BridgeError::InvalidArgs(format!(
            "'{type_name}' does not exist or cannot be instantiated"
        )));
    }
    if !class_db.is_parent_class(type_name, "Node") {
        return Err(BridgeError::InvalidArgs(format!("'{type_name}' is not a Node subclass")));
    }
    class_db
        .instantiate(type_name)
        .try_to::<Gd<Node>>()
        .map_err(|e| BridgeError::ResourceError(format!("failed to instantiate '{type_name}': {e}")))
}

/// Frames to wait for a scene to finish opening before giving up.
/// `open_scene_from_path` returns before the new scene is necessarily ready:
/// `get_edited_scene_root()` can still report the previous scene (or none)
/// for a frame or more afterward, so this polls rather than assuming the
/// call is synchronous.
const SCENE_OPEN_DEADLINE_FRAMES: u64 = 600;

pub fn open(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let path = match require_str(args, "path") {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };
    if let Err(e) = validate_project_path(&path) {
        return HandlerOutcome::Done(Err(e));
    }
    EditorInterface::singleton().open_scene_from_path(path.as_str());
    HandlerOutcome::Pending(Box::new(SceneOpenPending {
        path,
        deadline_frame: ctx.frame_index.saturating_add(SCENE_OPEN_DEADLINE_FRAMES),
    }))
}

struct SceneOpenPending {
    path: String,
    deadline_frame: u64,
}

impl PendingOp for SceneOpenPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        // get_scene_file_path() and get_open_scenes() are tab-bar-backed and
        // do not reliably populate under headless --editor runs. edited_scene_root()
        // is the same call gd_scene_tree_get itself makes and is ready
        // immediately after open_scene_from_path in practice; kept as a bounded
        // poll only as cheap insurance, not because a real race was confirmed.
        if edited_scene_root().is_ok() {
            return Some(Ok(json!({ "path": self.path })));
        }
        if ctx.frame_index >= self.deadline_frame {
            return Some(Err(BridgeError::Internal(format!(
                "scene '{}' did not finish opening before the deadline",
                self.path
            ))));
        }
        None
    }
}

pub fn create(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let prepared: Result<(String, String, bool), BridgeError> = (|| {
        let root_type = require_str(args, "root_type")?;
        let path = require_str(args, "path")?;
        validate_project_path(&path)?;
        let root_name = optional_str(args, "root_name");
        let open = optional_bool(args, "open").unwrap_or(true);

        let mut root = instantiate_node(&root_type)?;
        root.set_name(root_name.as_deref().unwrap_or(root_type.as_str()));

        let mut packed = PackedScene::new_gd();
        let pack_err = packed.pack(&root);
        if pack_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to pack scene: {pack_err:?}")));
        }
        let save_err = ResourceSaver::singleton().save_ex(&packed).path(path.as_str()).done();
        if save_err != GdError::OK {
            return Err(BridgeError::ResourceError(format!("failed to save scene to '{path}': {save_err:?}")));
        }
        Ok((path, root_type, open))
    })();

    let (path, root_type, open) = match prepared {
        Ok(v) => v,
        Err(e) => return HandlerOutcome::Done(Err(e)),
    };

    trigger_rescan(false, ctx, move || {
        if open {
            EditorInterface::singleton().open_scene_from_path(path.as_str());
        }
        Ok(json!({ "path": path, "root_type": root_type, "opened": open }))
    })
}

pub fn tree_get(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let max_depth = optional_u64(args, "max_depth").unwrap_or(DEFAULT_TREE_DEPTH);
        let root = edited_scene_root()?;
        let start = match optional_str(args, "root_path") {
            Some(path) => resolve_editor_node(&path)?,
            None => root.clone(),
        };
        Ok(json!({ "tree": tree_node(&root, &start, max_depth) }))
    })())
}

fn tree_node(scene_root: &Gd<Node>, node: &Gd<Node>, depth_remaining: u64) -> Value {
    let script_path = node.get_script().map(|script| script.get_path().to_string());
    let mut entry = json!({
        "name": node.get_name().to_string(),
        "class": node.get_class().to_string(),
        "path": relative_path(scene_root, node),
        "child_count": node.get_child_count(),
        "script": script_path,
    });
    if depth_remaining > 0 {
        let children: Vec<Value> = node
            .get_children()
            .iter_shared()
            .map(|child| tree_node(scene_root, &child, depth_remaining - 1))
            .collect();
        entry["children"] = Value::Array(children);
    } else if node.get_child_count() > 0 {
        entry["children_truncated"] = json!(true);
    }
    entry
}

pub fn save(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let mut editor = EditorInterface::singleton();
        match optional_str(args, "path") {
            Some(path) => {
                validate_project_path(&path)?;
                editor.save_scene_as(path.as_str());
                Ok(json!({ "path": path }))
            }
            None => {
                let err = editor.save_scene();
                if err != GdError::OK {
                    return Err(BridgeError::ResourceError(format!("failed to save the active scene: {err:?}")));
                }
                Ok(json!({ "saved": true }))
            }
        }
    })())
}

pub fn save_all(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    EditorInterface::singleton().save_all_scenes();
    HandlerOutcome::Done(Ok(json!({ "saved_all": true })))
}

pub fn node_add(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let parent_path = require_str(args, "parent_path")?;
        let type_name = require_str(args, "type")?;
        let name = optional_str(args, "name");

        let parent = resolve_editor_node(&parent_path)?;
        let mut new_node = instantiate_node(&type_name)?;
        if let Some(name) = &name {
            new_node.set_name(name.as_str());
        }

        let root = edited_scene_root()?;
        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Add {type_name}");
        ur.create_action(action_name.as_str());
        ur.try_add_do_method(&parent, "add_child", &[new_node.to_variant()])
            .map_err(|e| call_error("add_do_method(add_child)", e))?;
        ur.try_add_do_method(&new_node, "set_owner", &[root.to_variant()])
            .map_err(|e| call_error("add_do_method(set_owner)", e))?;
        crate::handlers::editor::support::queue_owner_recursive(&mut ur, &new_node, &root);
        ur.add_do_reference(&new_node);
        ur.try_add_undo_method(&parent, "remove_child", &[new_node.to_variant()])
            .map_err(|e| call_error("add_undo_method(remove_child)", e))?;
        ur.commit_action();

        Ok(json!({
            "node_path": relative_path(&root, &new_node),
            "name": new_node.get_name().to_string(),
            "class": type_name,
            "action_name": action_name,
        }))
    })())
}

pub fn node_remove(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let node = resolve_editor_node(&node_path)?;
        let root = edited_scene_root()?;
        if node == root {
            return Err(BridgeError::InvalidArgs("cannot remove the edited scene root".into()));
        }
        let parent = node
            .get_parent()
            .ok_or_else(|| BridgeError::Internal(format!("node at '{node_path}' has no parent")))?;

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Remove {}", node.get_name());
        ur.create_action(action_name.as_str());
        ur.try_add_do_method(&parent, "remove_child", &[node.to_variant()])
            .map_err(|e| call_error("add_do_method(remove_child)", e))?;
        ur.try_add_undo_method(&parent, "add_child", &[node.to_variant()])
            .map_err(|e| call_error("add_undo_method(add_child)", e))?;
        ur.try_add_undo_method(&node, "set_owner", &[root.to_variant()])
            .map_err(|e| call_error("add_undo_method(set_owner)", e))?;
        ur.add_undo_reference(&node);
        ur.commit_action();

        Ok(json!({ "node_path": node_path, "action_name": action_name }))
    })())
}

pub fn node_reparent(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let new_parent_path = require_str(args, "new_parent_path")?;
        let new_name = optional_str(args, "new_name");

        let node = resolve_editor_node(&node_path)?;
        let root = edited_scene_root()?;
        if node == root {
            return Err(BridgeError::InvalidArgs("cannot reparent the edited scene root".into()));
        }
        let old_parent = node
            .get_parent()
            .ok_or_else(|| BridgeError::Internal(format!("node at '{node_path}' has no parent")))?;
        let new_parent = resolve_editor_node(&new_parent_path)?;
        let old_name = node.get_name().to_string();

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Reparent {old_name}");
        ur.create_action(action_name.as_str());
        // Node::reparent's second parameter (keep_global_transform) defaults to
        // true; only one positional argument is supplied here (verify this
        // resolves the default correctly against a live editor).
        ur.try_add_do_method(&node, "reparent", &[new_parent.to_variant()])
            .map_err(|e| call_error("add_do_method(reparent)", e))?;
        ur.try_add_undo_method(&node, "reparent", &[old_parent.to_variant()])
            .map_err(|e| call_error("add_undo_method(reparent)", e))?;
        if let Some(new_name) = &new_name {
            ur.add_do_property(&node, "name", &new_name.to_variant());
            ur.add_undo_property(&node, "name", &old_name.to_variant());
        }
        ur.commit_action();

        Ok(json!({ "node_path": relative_path(&root, &node), "action_name": action_name }))
    })())
}

pub fn node_rename(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let new_name = require_str(args, "new_name")?;
        let node = resolve_editor_node(&node_path)?;
        let root = edited_scene_root()?;
        let old_name = node.get_name().to_string();

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Rename {old_name} to {new_name}");
        ur.create_action(action_name.as_str());
        ur.add_do_property(&node, "name", &new_name.to_variant());
        ur.add_undo_property(&node, "name", &old_name.to_variant());
        ur.commit_action();

        Ok(json!({ "node_path": relative_path(&root, &node), "action_name": action_name }))
    })())
}

pub fn node_duplicate(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let node_path = require_str(args, "node_path")?;
        let new_name = optional_str(args, "new_name");

        let original = resolve_editor_node(&node_path)?;
        let root = edited_scene_root()?;
        let parent = original
            .get_parent()
            .ok_or_else(|| BridgeError::InvalidArgs("cannot duplicate the edited scene root".into()))?;

        let mut copy = original.duplicate_node();
        if let Some(new_name) = &new_name {
            copy.set_name(new_name.as_str());
        }

        let mut ur = undo_redo()?;
        let action_name = format!("Conduit: Duplicate {}", original.get_name());
        ur.create_action(action_name.as_str());
        ur.try_add_do_method(&parent, "add_child", &[copy.to_variant()])
            .map_err(|e| call_error("add_do_method(add_child)", e))?;
        ur.try_add_do_method(&copy, "set_owner", &[root.to_variant()])
            .map_err(|e| call_error("add_do_method(set_owner)", e))?;
        crate::handlers::editor::support::queue_owner_recursive(&mut ur, &copy, &root);
        ur.add_do_reference(&copy);
        ur.try_add_undo_method(&parent, "remove_child", &[copy.to_variant()])
            .map_err(|e| call_error("add_undo_method(remove_child)", e))?;
        ur.commit_action();

        Ok(json!({ "node_path": relative_path(&root, &copy), "action_name": action_name }))
    })())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Every handler validates its arguments before touching an engine
    // singleton (module doc comment / docs/api-gaps.md), so a missing
    // required argument fails fast and is testable without Godot.
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
    fn open_requires_path() {
        assert_invalid_args(open(&json!({}), &ctx()));
    }

    #[test]
    fn open_rejects_a_path_outside_the_project() {
        assert_invalid_args(open(&json!({ "path": "/etc/passwd" }), &ctx()));
    }

    #[test]
    fn create_requires_root_type_and_path() {
        assert_invalid_args(create(&json!({}), &ctx()));
        assert_invalid_args(create(&json!({ "root_type": "Node2D" }), &ctx()));
        assert_invalid_args(create(&json!({ "root_type": "Node2D", "path": "../escape.tscn" }), &ctx()));
    }

    #[test]
    fn node_add_requires_parent_path_and_type() {
        assert_invalid_args(node_add(&json!({}), &ctx()));
        assert_invalid_args(node_add(&json!({ "parent_path": "." }), &ctx()));
    }

    #[test]
    fn node_remove_requires_node_path() {
        assert_invalid_args(node_remove(&json!({}), &ctx()));
    }

    #[test]
    fn node_reparent_requires_node_path_and_new_parent_path() {
        assert_invalid_args(node_reparent(&json!({}), &ctx()));
        assert_invalid_args(node_reparent(&json!({ "node_path": "Player" }), &ctx()));
    }

    #[test]
    fn node_rename_requires_node_path_and_new_name() {
        assert_invalid_args(node_rename(&json!({}), &ctx()));
        assert_invalid_args(node_rename(&json!({ "node_path": "Player" }), &ctx()));
    }

    #[test]
    fn node_duplicate_requires_node_path() {
        assert_invalid_args(node_duplicate(&json!({}), &ctx()));
    }
}
