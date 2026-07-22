//! The `ConduitRuntime` autoload node: the game personality.
//!
//! An `EditorPlugin` is only instantiated in the editor, so it cannot bring the
//! bridge online inside a launched game. Instead this plain `Node` is shipped as
//! a one-node scene and registered as a singleton autoload
//! (`res://addons/conduit/conduit_runtime.tscn`), so the engine instantiates it
//! into the running game's tree. It shares all its machinery with the editor
//! plugin through [`BridgeCore`]; only the role, registry, and socket endpoint
//! differ. Activation still requires the explicit opt-in of section 6.3, so the
//! listener never binds in a shipped game.

use godot::classes::{INode, Node};
use godot::prelude::*;

use crate::bridge_core::BridgeCore;
use crate::handlers::runtime::project_tools::ProjectToolsWatcher;
use crate::handlers::HandlerRegistry;
use crate::transport::ipc::Role;

#[derive(GodotClass)]
#[class(base=Node)]
pub struct ConduitRuntime {
    base: Base<Node>,
    core: BridgeCore,
    watcher: Option<ProjectToolsWatcher>,
}

#[godot_api]
impl INode for ConduitRuntime {
    fn init(base: Base<Node>) -> Self {
        ConduitRuntime { base, core: BridgeCore::new(Role::Game, HandlerRegistry::game()), watcher: None }
    }

    fn enter_tree(&mut self) {
        // The bridge must keep draining while the game is paused, both so the
        // agent can inspect a paused game and so gd_step_frames can count ticks
        // in an always-processing node (whitepaper section 6.4).
        let mode = godot::classes::node::ProcessMode::ALWAYS;
        self.base_mut().set_process_mode(mode);
        self.core.start();
        // The game personality's one event producer: conduit_tools set changes
        // (whitepaper section 8, phase 9).
        self.watcher = Some(ProjectToolsWatcher::new(self.core.event_sender()));
    }

    fn process(&mut self, delta: f64) {
        self.core.run_frame(delta * 1000.0);
        if let Some(watcher) = &mut self.watcher {
            watcher.service();
        }
        // WebSocketPeer makes no progress unless polled every frame.
        crate::handlers::runtime::net::service_frame();
    }

    fn exit_tree(&mut self) {
        self.watcher = None;
        self.core.stop();
    }
}
