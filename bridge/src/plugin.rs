//! The `ConduitBridge` editor plugin: the single gdext-facing component.
//!
//! It owns the dispatcher and the main-thread ends of the command channels,
//! spawns the IO listener when activation permits, and drives the dispatcher
//! once per frame from `_process`. All engine calls happen here, on the main
//! thread; the listener thread it spawns never touches the engine.

use crossbeam_channel::{Receiver, Sender};
use godot::classes::{EditorPlugin, Engine, IEditorPlugin, Os, ProjectSettings};
use godot::prelude::*;

use crate::dispatcher::{Dispatcher, DrainBudget};
use crate::handlers::HandlerRegistry;
use crate::protocol::{Command, Response};
use crate::transport::channels::CommandChannels;
use crate::transport::ipc::{socket_path, ActivationContext, Listener};

#[derive(GodotClass)]
#[class(tool, base=EditorPlugin)]
pub struct ConduitBridge {
    base: Base<EditorPlugin>,
    inbound_rx: Receiver<Command>,
    outbound_tx: Sender<Response>,
    listener_endpoints: Option<(Sender<Command>, Receiver<Response>)>,
    dispatcher: Dispatcher,
    listener: Option<Listener>,
}

#[godot_api]
impl IEditorPlugin for ConduitBridge {
    fn init(base: Base<EditorPlugin>) -> Self {
        let channels = CommandChannels::default();
        let dispatcher = Dispatcher::new(HandlerRegistry::phase1(), DrainBudget::default());
        ConduitBridge {
            base,
            inbound_rx: channels.inbound_rx,
            outbound_tx: channels.outbound_tx,
            listener_endpoints: Some((channels.inbound_tx, channels.outbound_rx)),
            dispatcher,
            listener: None,
        }
    }

    fn enter_tree(&mut self) {
        // PROCESS_MODE_ALWAYS keeps the command loop draining even when the tree
        // is paused, which is exactly when an agent most wants to inspect state
        // (whitepaper section 6.4).
        let mode = godot::classes::node::ProcessMode::ALWAYS;
        self.base_mut().set_process_mode(mode);

        let context = self.activation_context();
        if !context.should_bind() {
            godot_print!("Conduit: listener not activated (release build or no opt-in)");
            return;
        }

        let Some((inbound_tx, outbound_rx)) = self.listener_endpoints.take() else {
            return;
        };
        let path = socket_path(&self.project_path());
        match Listener::spawn(path, inbound_tx, outbound_rx) {
            Ok(listener) => {
                godot_print!("Conduit: listening on {}", listener.path().display());
                self.listener = Some(listener);
            }
            Err(err) => {
                godot_error!("Conduit: failed to bind command listener: {err}");
            }
        }
    }

    fn process(&mut self, delta: f64) {
        let delta_ms = delta * 1000.0;
        // Disjoint field borrows: the dispatcher is mutated while the channel
        // endpoints are read; all three are distinct fields of self.
        self.dispatcher.run_frame(&self.inbound_rx, &self.outbound_tx, delta_ms);
    }

    fn exit_tree(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.stop();
        }
    }
}

impl ConduitBridge {
    fn activation_context(&self) -> ActivationContext {
        let engine = Engine::singleton();
        let os = Os::singleton();
        let is_editor = engine.is_editor_hint();
        // "release build" here means an exported release template, never the
        // editor. See whitepaper 6.3; tag semantics verified against the Godot
        // feature-tag docs for the target release.
        let is_release_build =
            os.has_feature("template_release") || (os.has_feature("release") && !is_editor);
        let cmdline_opt_in = os.get_cmdline_user_args().to_vec().iter().any(|arg| {
            let arg = arg.to_string();
            arg == "--conduit" || arg == "conduit"
        });
        let env_opt_in =
            std::env::var("CONDUIT_ENABLE").map(|value| !value.is_empty()).unwrap_or(false);

        ActivationContext { is_editor, is_release_build, cmdline_opt_in, env_opt_in }
    }

    fn project_path(&self) -> String {
        ProjectSettings::singleton().globalize_path("res://").to_string()
    }
}
