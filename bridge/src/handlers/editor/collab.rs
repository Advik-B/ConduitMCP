//! Editor state and collaboration handlers (whitepaper sections 6.8 and 8):
//! selecting nodes in the scene dock, opening a script at a line, focusing an
//! object or resource in the inspector, switching the main screen, and capturing
//! an editor screenshot. These let an agent show a human what it means and stay
//! oriented in a shared session.

use godot::classes::{EditorInterface, RenderingServer, ResourceLoader, Script};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_str, optional_u64, require_str};
use crate::handlers::editor::support::{edited_scene_root, relative_path, resolve_editor_node, validate_project_path};
use crate::handlers::runtime::observe::{encode_viewport, is_headless_display, ConduitFrameSink, ImageFormat};
use crate::protocol::BridgeError;

const SCREENSHOT_DEADLINE_FRAMES: u64 = 600;
const MAIN_SCREENS: [&str; 5] = ["2D", "3D", "Script", "Game", "AssetLib"];

/// Select nodes in the scene dock through `EditorSelection` (op: set, add, clear).
pub fn select(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(select_inner(args))
}

fn select_inner(args: &Value) -> Result<Value, BridgeError> {
    let op = require_str(args, "op")?;
    let editor = EditorInterface::singleton();
    let mut selection = editor
        .get_selection()
        .ok_or_else(|| BridgeError::Internal("no EditorSelection available".into()))?;

    match op.as_str() {
        "clear" => selection.clear(),
        "set" | "add" => {
            if op == "set" {
                selection.clear();
            }
            let paths = args.get("node_paths").and_then(Value::as_array).ok_or_else(|| {
                BridgeError::InvalidArgs("'node_paths' must be an array of node paths for op set/add".into())
            })?;
            for entry in paths {
                let path = entry
                    .as_str()
                    .ok_or_else(|| BridgeError::InvalidArgs("each node_paths entry must be a string".into()))?;
                let node = resolve_editor_node(path)?;
                selection.add_node(&node);
            }
        }
        other => {
            return Err(BridgeError::InvalidArgs(format!("unknown select op '{other}'; expected set, add, or clear")));
        }
    }

    let root = edited_scene_root()?;
    let selected: Vec<String> = selection
        .get_selected_nodes()
        .iter_shared()
        .map(|node| relative_path(&root, &node))
        .collect();
    Ok(json!({ "selection": selected }))
}

/// Open a script in the script editor at an optional line and column.
pub fn open_script(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(open_script_inner(args))
}

fn open_script_inner(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    validate_project_path(&path)?;
    let resource = ResourceLoader::singleton()
        .load(&path)
        .ok_or_else(|| BridgeError::ResourceError(format!("could not load '{path}'")))?;
    let script: Gd<Script> = resource
        .try_cast()
        .map_err(|_| BridgeError::InvalidArgs(format!("'{path}' is not a script")))?;

    let line = optional_u64(args, "line").map(|line| line as i32).unwrap_or(-1);
    let column = optional_u64(args, "column").map(|column| column as i32).unwrap_or(0);

    let mut editor = EditorInterface::singleton();
    editor.set_main_screen_editor("Script");
    editor.edit_script_ex(&script).line(line).column(column).done();
    Ok(json!({ "opened": path, "line": line, "column": column }))
}

/// Focus a node or a resource in the inspector (exactly one of node_path,
/// resource_path).
pub fn inspect(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(inspect_inner(args))
}

fn inspect_inner(args: &Value) -> Result<Value, BridgeError> {
    let node_path = optional_str(args, "node_path");
    let resource_path = optional_str(args, "resource_path");
    let mut editor = EditorInterface::singleton();
    match (node_path, resource_path) {
        (Some(node_path), None) => {
            let node = resolve_editor_node(&node_path)?;
            editor.edit_node(&node);
            editor.inspect_object(&node);
            Ok(json!({ "inspecting": "node", "node_path": node_path }))
        }
        (None, Some(resource_path)) => {
            validate_project_path(&resource_path)?;
            let resource = ResourceLoader::singleton()
                .load(&resource_path)
                .ok_or_else(|| BridgeError::ResourceError(format!("could not load '{resource_path}'")))?;
            editor.edit_resource(&resource);
            Ok(json!({ "inspecting": "resource", "resource_path": resource_path }))
        }
        _ => Err(BridgeError::InvalidArgs("provide exactly one of 'node_path' or 'resource_path'".into())),
    }
}

/// Switch the editor's main screen (2D, 3D, Script, Game, AssetLib).
pub fn set_main_screen(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(set_main_screen_inner(args))
}

fn set_main_screen_inner(args: &Value) -> Result<Value, BridgeError> {
    let name = require_str(args, "name")?;
    if !MAIN_SCREENS.contains(&name.as_str()) {
        return Err(BridgeError::InvalidArgs(format!(
            "unknown main screen '{name}'; expected one of {MAIN_SCREENS:?}"
        )));
    }
    EditorInterface::singleton().set_main_screen_editor(&name);
    Ok(json!({ "main_screen": name }))
}

/// Capture a screenshot of the editor window after the next drawn frame.
pub fn screenshot(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    if is_headless_display() {
        return HandlerOutcome::Done(Err(BridgeError::NotAvailableHeadless(
            "editor screenshots are unavailable under a headless display server".into(),
        )));
    }
    let max_dimension = optional_u64(args, "max_dimension").map(|value| value as i32);
    let format = ImageFormat::from_arg(optional_str(args, "format").as_deref().unwrap_or("png"));

    let sink = ConduitFrameSink::new_gd();
    let callable = Callable::from_object_method(&sink, "on_frame");
    RenderingServer::singleton().connect("frame_post_draw", &callable);

    HandlerOutcome::Pending(Box::new(EditorScreenshotPending {
        sink,
        callable,
        max_dimension,
        format,
        deadline_frame: ctx.frame_index.saturating_add(SCREENSHOT_DEADLINE_FRAMES),
    }))
}

struct EditorScreenshotPending {
    sink: Gd<ConduitFrameSink>,
    callable: Callable,
    max_dimension: Option<i32>,
    format: ImageFormat,
    deadline_frame: u64,
}

impl EditorScreenshotPending {
    fn disconnect(&mut self) {
        let mut server = RenderingServer::singleton();
        if server.is_connected("frame_post_draw", &self.callable) {
            server.disconnect("frame_post_draw", &self.callable);
        }
    }

    fn capture(&self) -> Result<Value, BridgeError> {
        let base = EditorInterface::singleton()
            .get_base_control()
            .ok_or_else(|| BridgeError::Internal("editor has no base control".into()))?;
        let viewport = base
            .get_viewport()
            .ok_or_else(|| BridgeError::Internal("editor base control has no viewport".into()))?;
        encode_viewport(&viewport, self.max_dimension, self.format)
    }
}

impl PendingOp for EditorScreenshotPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if self.sink.bind().drawn() {
            self.disconnect();
            return Some(self.capture());
        }
        if ctx.frame_index >= self.deadline_frame {
            self.disconnect();
            return Some(Err(BridgeError::Internal("no frame was drawn before the screenshot deadline".into())));
        }
        None
    }
}
