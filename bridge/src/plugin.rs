//! The `ConduitBridge` editor plugin: the editor personality.
//!
//! It is auto-instantiated by the editor (the `tool` attribute) and delegates
//! all work to the shared [`BridgeCore`]. The matching game personality lives
//! in `runtime_node.rs`, because an `EditorPlugin` is only instantiated in the
//! editor process and never in a launched game.

use godot::classes::{EditorPlugin, IEditorPlugin};
use godot::prelude::*;

use crate::bridge_core::BridgeCore;
use crate::debugger::{self, ConduitDebuggerPlugin};
use crate::handlers::HandlerRegistry;
use crate::transport::ipc::Role;

#[derive(GodotClass)]
#[class(tool, base=EditorPlugin)]
pub struct ConduitBridge {
    base: Base<EditorPlugin>,
    core: BridgeCore,
    debugger: Option<Gd<ConduitDebuggerPlugin>>,
}

#[godot_api]
impl IEditorPlugin for ConduitBridge {
    fn init(base: Base<EditorPlugin>) -> Self {
        ConduitBridge { base, core: BridgeCore::new(Role::Editor, HandlerRegistry::editor()), debugger: None }
    }

    fn enter_tree(&mut self) {
        // PROCESS_MODE_ALWAYS keeps the command loop draining even when the tree
        // is paused, which is exactly when an agent most wants to inspect state
        // (whitepaper section 6.4).
        let mode = godot::classes::node::ProcessMode::ALWAYS;
        self.base_mut().set_process_mode(mode);
        self.core.start();

        // Register the debugger plugin so breakpoints, execution control, and
        // break events work for games launched from this editor (section 6.9).
        let plugin = debugger::install(self.core.event_sender());
        self.base_mut().add_debugger_plugin(&plugin);
        self.debugger = Some(plugin);
    }

    fn process(&mut self, delta: f64) {
        self.core.run_frame(delta * 1000.0);
        // While a game is halted at a breakpoint the editor throttles to its idle
        // tick rate; re-assert full speed each frame so debugger-dock reads settle
        // promptly (see debugger::keep_editor_responsive).
        debugger::keep_editor_responsive();
    }

    fn exit_tree(&mut self) {
        if let Some(plugin) = self.debugger.take() {
            self.base_mut().remove_debugger_plugin(&plugin);
        }
        debugger::uninstall();
        self.core.stop();
    }
}
