//! The `ConduitBridge` editor plugin: the editor personality.
//!
//! It is auto-instantiated by the editor (the `tool` attribute) and delegates
//! all work to the shared [`BridgeCore`]. The matching game personality lives
//! in `runtime_node.rs`, because an `EditorPlugin` is only instantiated in the
//! editor process and never in a launched game.

use std::time::Instant;

use godot::classes::editor_plugin::CustomControlContainer;
use godot::classes::{EditorPlugin, IEditorPlugin};
use godot::prelude::*;

use crate::bridge_core::BridgeCore;
use crate::debugger::{self, ConduitDebuggerPlugin};
use crate::editor_ui::{ConduitPanel, ConduitStatusIndicator};
use crate::handlers::HandlerRegistry;
use crate::transport::ipc::Role;
use crate::transport::status::{LinkSnapshot, LinkState};

/// How often the header labels (uptime, call counts) refresh. Link-state and
/// history changes bypass this and apply on the frame they are observed.
const HEADER_REFRESH_MS: f64 = 250.0;

#[derive(GodotClass)]
#[class(tool, base=EditorPlugin)]
pub struct ConduitBridge {
    base: Base<EditorPlugin>,
    core: BridgeCore,
    debugger: Option<Gd<ConduitDebuggerPlugin>>,
    indicator: Option<Gd<ConduitStatusIndicator>>,
    panel: Option<Gd<ConduitPanel>>,
    last_link: LinkSnapshot,
    connected_since: Option<Instant>,
    last_history_seq: u64,
    header_accum_ms: f64,
}

#[godot_api]
impl IEditorPlugin for ConduitBridge {
    fn init(base: Base<EditorPlugin>) -> Self {
        ConduitBridge {
            base,
            core: BridgeCore::new(Role::Editor, HandlerRegistry::editor()),
            debugger: None,
            indicator: None,
            panel: None,
            last_link: LinkSnapshot::default(),
            connected_since: None,
            last_history_seq: 0,
            header_accum_ms: 0.0,
        }
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

        // Status surface (section 6.10): the toolbar dot and the bottom panel.
        let mut indicator = ConduitStatusIndicator::new_alloc();
        let on_pressed = Callable::from_object_method(&self.to_gd(), "on_indicator_pressed");
        indicator.connect("pressed", &on_pressed);
        self.base_mut().add_control_to_container(CustomControlContainer::TOOLBAR, &indicator);
        self.indicator = Some(indicator);

        let panel = ConduitPanel::new_alloc();
        self.base_mut().add_control_to_bottom_panel(&panel, "Conduit");
        self.panel = Some(panel);
    }

    fn process(&mut self, delta: f64) {
        self.core.run_frame(delta * 1000.0);
        // While a game is halted at a breakpoint the editor throttles to its idle
        // tick rate; re-assert full speed each frame so debugger-dock reads settle
        // promptly (see debugger::keep_editor_responsive).
        debugger::keep_editor_responsive();
        // Fire a gd_editor_quit armed earlier, once its response has flushed.
        crate::handlers::editor::session::poll_deferred_quit();
        self.refresh_ui(delta * 1000.0);
    }

    fn exit_tree(&mut self) {
        if let Some(mut indicator) = self.indicator.take() {
            self.base_mut().remove_control_from_container(CustomControlContainer::TOOLBAR, &indicator);
            indicator.queue_free();
        }
        if let Some(mut panel) = self.panel.take() {
            self.base_mut().remove_control_from_bottom_panel(&panel);
            panel.queue_free();
        }
        if let Some(plugin) = self.debugger.take() {
            self.base_mut().remove_debugger_plugin(&plugin);
        }
        debugger::uninstall();
        self.core.stop();
    }
}

#[godot_api]
impl ConduitBridge {
    #[func]
    fn on_indicator_pressed(&mut self) {
        if let Some(panel) = self.panel.clone() {
            self.base_mut().make_bottom_panel_item_visible(&panel);
        }
    }
}

impl ConduitBridge {
    fn refresh_ui(&mut self, delta_ms: f64) {
        let snapshot = self.core.link_snapshot();
        let link_changed = snapshot != self.last_link;
        if link_changed {
            // A generation bump means a fresh connection even if the drop was
            // never observed, so connected-since resets across quick reconnects.
            self.connected_since =
                (snapshot.state == LinkState::Connected).then(Instant::now);
            let tooltip = self.tooltip_text(snapshot.state);
            if let Some(indicator) = self.indicator.as_mut() {
                indicator.bind_mut().set_state(snapshot.state, &tooltip);
            }
            self.last_link = snapshot;
        }

        let latest_seq = self.core.history().latest_seq();
        if latest_seq != self.last_history_seq {
            self.last_history_seq = latest_seq;
            if let Some(panel) = self.panel.as_mut() {
                panel.bind_mut().append_history(self.core.history());
            }
        }

        self.header_accum_ms += delta_ms;
        if link_changed || self.header_accum_ms >= HEADER_REFRESH_MS {
            self.header_accum_ms = 0.0;
            let uptime = self.connected_since.map(|since| since.elapsed());
            let completed = self.core.history().latest_seq();
            let in_flight = self.core.history().in_flight_count();
            if let Some(panel) = self.panel.as_mut() {
                panel.bind_mut().set_header(
                    snapshot.state,
                    self.core.endpoint_display(),
                    self.core.bind_failed(),
                    uptime,
                    completed,
                    in_flight,
                );
            }
        }
    }

    fn tooltip_text(&self, state: LinkState) -> String {
        let endpoint = self.core.endpoint_display().unwrap_or("unknown endpoint");
        let status = match state {
            LinkState::Connected => "Conduit: broker connected".to_string(),
            LinkState::Listening => format!("Conduit: waiting for broker on {endpoint}"),
            LinkState::Inactive if self.core.bind_failed() => {
                format!("Conduit: failed to bind {endpoint}")
            }
            LinkState::Inactive => "Conduit: inactive (not activated)".to_string(),
        };
        format!("{status}. Click to open the panel.")
    }
}
