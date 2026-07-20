//! The `ConduitBridge` editor plugin: the editor personality.
//!
//! It is auto-instantiated by the editor (the `tool` attribute) and delegates
//! all work to the shared [`BridgeCore`]. The matching game personality lives
//! in `runtime_node.rs`, because an `EditorPlugin` is only instantiated in the
//! editor process and never in a launched game.

use godot::classes::{EditorPlugin, IEditorPlugin};
use godot::prelude::*;

use crate::bridge_core::BridgeCore;
use crate::handlers::HandlerRegistry;
use crate::transport::ipc::Role;

#[derive(GodotClass)]
#[class(tool, base=EditorPlugin)]
pub struct ConduitBridge {
    base: Base<EditorPlugin>,
    core: BridgeCore,
}

#[godot_api]
impl IEditorPlugin for ConduitBridge {
    fn init(base: Base<EditorPlugin>) -> Self {
        ConduitBridge { base, core: BridgeCore::new(Role::Editor, HandlerRegistry::editor()) }
    }

    fn enter_tree(&mut self) {
        // PROCESS_MODE_ALWAYS keeps the command loop draining even when the tree
        // is paused, which is exactly when an agent most wants to inspect state
        // (whitepaper section 6.4).
        let mode = godot::classes::node::ProcessMode::ALWAYS;
        self.base_mut().set_process_mode(mode);
        self.core.start();
    }

    fn process(&mut self, delta: f64) {
        self.core.run_frame(delta * 1000.0);
    }

    fn exit_tree(&mut self) {
        self.core.stop();
    }
}
