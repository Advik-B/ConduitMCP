//! Shared machinery behind both node personalities.
//!
//! The editor plugin (`ConduitBridge`) and the game autoload (`ConduitRuntime`)
//! are thin gdext shells; everything they have in common lives here: the
//! dispatcher, the main-thread ends of the command channels, and the IO
//! listener. All engine calls made from this module happen on the main thread,
//! inside the owning node's lifecycle callbacks; the listener thread it spawns
//! never touches the engine (whitepaper section 6.4).

use crossbeam_channel::{Receiver, Sender};
use godot::classes::{Engine, Os, ProjectSettings};
use godot::prelude::*;

use crate::dispatcher::{Dispatcher, DrainBudget};
use crate::handlers::HandlerRegistry;
use crate::protocol::{Command, Hello, Response, PROTOCOL_VERSION};
use crate::transport::channels::CommandChannels;
use crate::transport::ipc::{socket_path, ActivationContext, Listener, Role};

/// Owns the dispatcher, the channel endpoints, and the listener handle for one
/// bridge personality. Constructed in the node's `init`, wired up in
/// `enter_tree` via [`BridgeCore::start`], driven each frame by
/// [`BridgeCore::run_frame`], and torn down in `exit_tree` via
/// [`BridgeCore::stop`].
pub struct BridgeCore {
    role: Role,
    inbound_rx: Receiver<Command>,
    outbound_tx: Sender<Response>,
    listener_endpoints: Option<(Sender<Command>, Receiver<Response>)>,
    dispatcher: Dispatcher,
    listener: Option<Listener>,
}

impl BridgeCore {
    pub fn new(role: Role, registry: HandlerRegistry) -> Self {
        let channels = CommandChannels::default();
        let dispatcher = Dispatcher::new(registry, DrainBudget::default());
        BridgeCore {
            role,
            inbound_rx: channels.inbound_rx,
            outbound_tx: channels.outbound_tx,
            listener_endpoints: Some((channels.inbound_tx, channels.outbound_rx)),
            dispatcher,
            listener: None,
        }
    }

    /// Bind the listener if activation permits (whitepaper section 6.3). Safe to
    /// call once; a second call is a no-op because the endpoints are taken.
    pub fn start(&mut self) {
        let context = current_activation_context(self.role);
        if !context.should_bind() {
            godot_print!("Conduit ({}): listener not activated (release build or no opt-in)", self.role.as_str());
            return;
        }

        let Some((inbound_tx, outbound_rx)) = self.listener_endpoints.take() else {
            return;
        };
        let project = project_path();
        let path = socket_path(self.role, &project);
        let hello = build_hello(self.role, &project).to_frame_payload();
        match Listener::spawn(path, hello, inbound_tx, outbound_rx) {
            Ok(listener) => {
                godot_print!("Conduit ({}): listening on {}", self.role.as_str(), listener.path().display());
                self.listener = Some(listener);
            }
            Err(err) => {
                godot_error!("Conduit ({}): failed to bind command listener: {err}", self.role.as_str());
            }
        }
    }

    pub fn run_frame(&mut self, delta_ms: f64) {
        // Disjoint field borrows: the dispatcher is mutated while the channel
        // endpoints are read; all three are distinct fields of self.
        self.dispatcher.run_frame(&self.inbound_rx, &self.outbound_tx, delta_ms);
    }

    pub fn stop(&mut self) {
        if let Some(mut listener) = self.listener.take() {
            listener.stop();
        }
    }
}

/// Read the activation facts from the engine (whitepaper section 6.3). The
/// pure decision lives in [`ActivationContext::should_bind`], tested without
/// Godot; this only gathers the inputs.
fn current_activation_context(role: Role) -> ActivationContext {
    let engine = Engine::singleton();
    let os = Os::singleton();
    let is_editor = engine.is_editor_hint();
    // "release build" here means an exported release template, never the editor.
    let is_release_build =
        os.has_feature("template_release") || (os.has_feature("release") && !is_editor);
    let cmdline_opt_in = os.get_cmdline_user_args().to_vec().iter().any(|arg| {
        let arg = arg.to_string();
        arg == "--conduit" || arg == "conduit"
    });
    let env_opt_in = std::env::var("CONDUIT_ENABLE").map(|value| !value.is_empty()).unwrap_or(false);

    // The editor personality only ever runs in the editor process; the game
    // personality only runs in a game process. The engine hint is authoritative
    // for the release check, but the role fixes the editor-binds rule so a game
    // node in a debug editor context (which does not happen in practice) still
    // requires the opt-in rather than binding implicitly.
    let is_editor = matches!(role, Role::Editor) && is_editor;
    ActivationContext { is_editor, is_release_build, cmdline_opt_in, env_opt_in }
}

fn project_path() -> String {
    ProjectSettings::singleton().globalize_path("res://").to_string()
}

fn build_hello(role: Role, project: &str) -> Hello {
    let version_info = Engine::singleton().get_version_info();
    let engine_version = version_info
        .get("string")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Hello {
        role: role.as_str().to_string(),
        protocol_version: PROTOCOL_VERSION,
        bridge_version: env!("CARGO_PKG_VERSION").to_string(),
        engine_version,
        project_path: project.to_string(),
        pid: std::process::id(),
    }
}
