//! Run and stop the game from the editor (whitepaper section 6.1). `gd_play` is
//! also the mechanism that spawns the game process the game bridge lives in; the
//! broker discovers and connects to that bridge once it announces itself.

use godot::classes::EditorInterface;
use godot::obj::Singleton;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::protocol::BridgeError;

/// Play the main scene, the currently edited scene, or a specific scene file.
pub fn play(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let mut editor = EditorInterface::singleton();
        let scene = args.get("scene").and_then(Value::as_str).unwrap_or("main");
        match scene {
            "main" => editor.play_main_scene(),
            "current" => editor.play_current_scene(),
            path if path.starts_with("res://") => editor.play_custom_scene(path),
            other => {
                return Err(BridgeError::InvalidArgs(format!(
                    "unknown scene '{other}'; expected 'main', 'current', or a res:// path"
                )));
            }
        }
        Ok(json!({ "playing": true, "scene": scene }))
    })())
}

pub fn stop(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let mut editor = EditorInterface::singleton();
    editor.stop_playing_scene();
    HandlerOutcome::Done(Ok(json!({ "stopped": true })))
}
