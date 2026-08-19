//! Phase 1 handler registry.
//!
//! Two handlers exercise the whole dispatcher path: `gd_ping` settles
//! immediately, and `gd_wait_frames` suspends and completes via deferred
//! resolution (the same mechanism `gd_game_eval`'s `await` will reuse in
//! phase 2). Handlers are pure functions of their arguments and the frame
//! context; they hold no engine state, so they run identically in the editor
//! and in the engine-free stress harness.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::protocol::BridgeError;

pub mod args;
pub mod classdb;
pub mod editor;
pub mod node_query;
pub mod runtime;
pub mod target;

type HandlerFn = fn(&Value, &FrameContext) -> HandlerOutcome;

pub struct HandlerRegistry {
    handlers: HashMap<&'static str, HandlerFn>,
}

impl HandlerRegistry {
    /// The engine-free registry: only the pure proof handlers. Used by the
    /// dispatcher unit tests and the stress harness, which run without Godot.
    pub fn phase1() -> Self {
        let mut handlers: HashMap<&'static str, HandlerFn> = HashMap::new();
        handlers.insert("gd_ping", ping);
        handlers.insert("gd_wait_frames", wait_frames);
        HandlerRegistry { handlers }
    }

    /// The editor personality's handler set. Diagnostics-only tools plus the
    /// edit-time tools that land in later commits share the common proof
    /// handlers here.
    pub fn editor() -> Self {
        let mut handlers: HashMap<&'static str, HandlerFn> = HashMap::new();
        handlers.insert("gd_ping", ping);
        handlers.insert("gd_wait_frames", wait_frames);
        handlers.insert("gd_play", editor::play::play);
        handlers.insert("gd_stop", editor::play::stop);
        handlers.insert("gd_scene_open", editor::scene::open);
        handlers.insert("gd_scene_create", editor::scene::create);
        handlers.insert("gd_scene_tree_get", editor::scene::tree_get);
        handlers.insert("gd_scene_save", editor::scene::save);
        handlers.insert("gd_scene_save_all", editor::scene::save_all);
        handlers.insert("gd_node_add", editor::scene::node_add);
        handlers.insert("gd_node_remove", editor::scene::node_remove);
        handlers.insert("gd_node_reparent", editor::scene::node_reparent);
        handlers.insert("gd_node_rename", editor::scene::node_rename);
        handlers.insert("gd_node_duplicate", editor::scene::node_duplicate);
        handlers.insert("gd_scene_node_get_property", editor::properties::get_property);
        handlers.insert("gd_scene_node_set_property", editor::properties::set_property);
        handlers.insert("gd_scene_node_call", editor::properties::call_method);
        handlers.insert("gd_scene_instantiate", editor::scene::scene_instantiate);
        handlers.insert("gd_scene_signal", editor::wiring::scene_signal);
        handlers.insert("gd_node_group", editor::wiring::node_group);
        handlers.insert("gd_scene_find_nodes", editor::query::scene_find_nodes);
        handlers.insert("gd_autoload", editor::autoload::autoload);
        handlers.insert("gd_input_map", editor::input_map::input_map);
        handlers.insert("gd_editor_eval", editor::eval::editor_eval);
        handlers.insert("gd_script_create", editor::script::create);
        handlers.insert("gd_script_attach", editor::script::attach);
        handlers.insert("gd_script_detach", editor::script::detach);
        handlers.insert("gd_script_validate", editor::script::validate);
        handlers.insert("gd_resource_create", editor::resource::create);
        handlers.insert("gd_resource_set_property", editor::resource::set_property);
        handlers.insert("gd_resource_get_property", editor::resource::get_property);
        handlers.insert("gd_resource_call", editor::resource::call_method);
        handlers.insert("gd_project_get_setting", editor::project::get_setting);
        handlers.insert("gd_project_set_setting", editor::project::set_setting);
        handlers.insert("gd_undo", editor::editor_state::undo);
        handlers.insert("gd_redo", editor::editor_state::redo);
        handlers.insert("gd_editor_get_state", editor::editor_state::get_state);
        handlers.insert("gd_debug", editor::debug::debug);
        handlers.insert("gd_editor_select", editor::collab::select);
        handlers.insert("gd_editor_open_script", editor::collab::open_script);
        handlers.insert("gd_editor_inspect", editor::collab::inspect);
        handlers.insert("gd_editor_set_main_screen", editor::collab::set_main_screen);
        handlers.insert("gd_editor_screenshot", editor::collab::screenshot);
        handlers.insert("gd_editor_list_dialogs", editor::ui::list_dialogs);
        handlers.insert("gd_editor_dialog_choose", editor::ui::dialog_choose);
        handlers.insert("gd_editor_ui", editor::ui::editor_ui);
        handlers.insert("gd_editor_pixel_move", editor::pixel::pixel_move);
        handlers.insert("gd_editor_pixel_click", editor::pixel::pixel_click);
        handlers.insert("gd_editor_pixel_drag", editor::pixel::pixel_drag);
        handlers.insert("gd_editor_window_info", editor::pixel::window_info);
        handlers.insert("gd_asset_add", editor::assets::add);
        handlers.insert("gd_asset_reimport", editor::assets::reimport);
        handlers.insert("gd_file_move", editor::files::move_file);
        handlers.insert("gd_file_delete", editor::files::delete);
        handlers.insert("gd_export_project", editor::import_export::export_project);
        handlers.insert("gd_export_presets", editor::import_export::export_presets);
        handlers.insert("gd_editor_quit", editor::session::editor_quit);
        handlers.insert("gd_classdb", classdb::classdb);
        HandlerRegistry { handlers }
    }

    /// The game personality's handler set. The runtime inspection, evaluation,
    /// input, and observation tools register here as they are implemented.
    pub fn game() -> Self {
        let mut handlers: HashMap<&'static str, HandlerFn> = HashMap::new();
        handlers.insert("gd_ping", ping);
        handlers.insert("gd_wait_frames", wait_frames);
        handlers.insert("gd_tree_get", runtime::inspect::get_tree);
        handlers.insert("gd_node_get_info", runtime::inspect::get_info);
        handlers.insert("gd_node_get_property", runtime::inspect::get_property);
        handlers.insert("gd_node_set_property", runtime::mutate::set_property);
        handlers.insert("gd_node_call", runtime::mutate::call_method);
        handlers.insert("gd_game_eval", runtime::eval::game_eval);
        handlers.insert("gd_signal", runtime::signals::signal);
        handlers.insert("gd_input", runtime::input::input);
        handlers.insert("gd_screenshot", runtime::observe::screenshot);
        handlers.insert("gd_perf", runtime::observe::perf);
        handlers.insert("gd_get_logs", runtime::observe::get_logs);
        handlers.insert("gd_get_errors", runtime::observe::get_errors);
        handlers.insert("gd_pause", runtime::lifecycle::pause);
        handlers.insert("gd_step_frames", runtime::lifecycle::step_frames);
        handlers.insert("gd_wait_time", runtime::lifecycle::wait_time);
        handlers.insert("gd_set_time_scale", runtime::lifecycle::set_time_scale);
        handlers.insert("gd_find_nodes", runtime::query::find_nodes);
        handlers.insert("gd_classdb", classdb::classdb);
        handlers.insert("gd_animation", runtime::animation::animation);
        handlers.insert("gd_physics", runtime::physics::physics);
        handlers.insert("gd_render", runtime::render::render);
        handlers.insert("gd_audio", runtime::audio::audio);
        handlers.insert("gd_tilemap", runtime::systems2d3d::tilemap);
        handlers.insert("gd_window", runtime::system::window);
        handlers.insert("gd_tree_mutate", runtime::mutate::tree_mutate);
        handlers.insert("gd_project_tools_list", runtime::project_tools::tools_list);
        handlers.insert("gd_project_call", runtime::project_tools::project_call);
        handlers.insert("gd_http_request", runtime::net::http_request);
        handlers.insert("gd_websocket", runtime::net::websocket);
        handlers.insert("gd_multiplayer", runtime::net::multiplayer);
        HandlerRegistry { handlers }
    }

    pub fn dispatch(&self, tool: &str, args: &Value, ctx: &FrameContext) -> HandlerOutcome {
        match self.handlers.get(tool) {
            Some(handler) => handler(args, ctx),
            None => HandlerOutcome::Done(Err(BridgeError::UnknownTool(tool.to_string()))),
        }
    }

    pub fn tool_names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self.handlers.keys().copied().collect();
        names.sort_unstable();
        names
    }
}

/// No-op round-trip proving the full path. Returns a constant plus frame stats
/// so a client can observe the editor's frame cadence (responsiveness) while
/// flooding the queue.
fn ping(_args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(Ok(json!({
        "pong": true,
        "frame": ctx.frame_index,
        "last_delta_ms": ctx.last_delta_ms,
    })))
}

/// The one await-style command: suspends and settles exactly `frames` frames
/// after it was drained, via the deferred-completion path.
fn wait_frames(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let frames = match args.get("frames").and_then(Value::as_u64) {
        Some(frames) if frames >= 1 => frames,
        _ => {
            return HandlerOutcome::Done(Err(BridgeError::InvalidArgs(
                "'frames' must be an integer >= 1".to_string(),
            )));
        }
    };
    HandlerOutcome::Pending(Box::new(WaitFrames {
        remaining: frames,
        total: frames,
        submitted_frame: ctx.frame_index,
    }))
}

struct WaitFrames {
    remaining: u64,
    total: u64,
    submitted_frame: u64,
}

impl PendingOp for WaitFrames {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        self.remaining -= 1;
        if self.remaining == 0 {
            Some(Ok(json!({
                "waited_frames": self.total,
                "submitted_frame": self.submitted_frame,
                "completed_frame": ctx.frame_index,
            })))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_exposes_phase1_tools() {
        let registry = HandlerRegistry::phase1();
        assert_eq!(registry.tool_names(), vec!["gd_ping", "gd_wait_frames"]);
    }

    #[test]
    fn ping_is_immediate() {
        let registry = HandlerRegistry::phase1();
        let ctx = FrameContext { frame_index: 10, last_delta_ms: 16.6 };
        match registry.dispatch("gd_ping", &json!({}), &ctx) {
            HandlerOutcome::Done(Ok(value)) => {
                assert_eq!(value["pong"], true);
                assert_eq!(value["frame"], 10);
            }
            _ => panic!("gd_ping should settle immediately"),
        }
    }

    #[test]
    fn editor_registry_includes_debugger_tool() {
        let names = HandlerRegistry::editor().tool_names();
        assert!(names.contains(&"gd_debug"), "gd_debug must be registered on the editor bridge");
    }

    #[test]
    fn classdb_registers_in_both_personalities() {
        assert!(HandlerRegistry::editor().tool_names().contains(&"gd_classdb"));
        assert!(HandlerRegistry::game().tool_names().contains(&"gd_classdb"));
    }

    #[test]
    fn game_registry_includes_phase8_tools() {
        let names = HandlerRegistry::game().tool_names();
        for tool in [
            "gd_animation",
            "gd_physics",
            "gd_render",
            "gd_audio",
            "gd_tilemap",
            "gd_window",
            "gd_tree_mutate",
        ] {
            assert!(names.contains(&tool), "{tool} must be registered on the game bridge");
        }
    }

    #[test]
    fn phase8_tools_stay_off_the_editor_bridge() {
        let names = HandlerRegistry::editor().tool_names();
        for tool in ["gd_animation", "gd_physics", "gd_tree_mutate"] {
            assert!(!names.contains(&tool), "{tool} must not be registered on the editor bridge");
        }
    }

    #[test]
    fn editor_registry_includes_phase9_session_tools() {
        let names = HandlerRegistry::editor().tool_names();
        for tool in ["gd_export_presets", "gd_editor_quit"] {
            assert!(names.contains(&tool), "{tool} must be registered on the editor bridge");
        }
    }

    #[test]
    fn game_registry_includes_phase9_tools() {
        let names = HandlerRegistry::game().tool_names();
        for tool in ["gd_project_tools_list", "gd_project_call", "gd_http_request", "gd_websocket", "gd_multiplayer"] {
            assert!(names.contains(&tool), "{tool} must be registered on the game bridge");
        }
    }

    #[test]
    fn phase9_game_tools_stay_off_the_editor_bridge() {
        let names = HandlerRegistry::editor().tool_names();
        for tool in ["gd_project_tools_list", "gd_project_call", "gd_http_request", "gd_websocket", "gd_multiplayer"] {
            assert!(!names.contains(&tool), "{tool} must not be registered on the editor bridge");
        }
    }

    #[test]
    fn wait_frames_suspends() {
        let registry = HandlerRegistry::phase1();
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        assert!(matches!(
            registry.dispatch("gd_wait_frames", &json!({"frames": 2}), &ctx),
            HandlerOutcome::Pending(_)
        ));
    }
}
