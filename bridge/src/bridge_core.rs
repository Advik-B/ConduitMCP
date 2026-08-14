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
use crate::history::ToolHistory;
use crate::protocol::{Command, EventSender, Hello, Response, PROTOCOL_VERSION};
use crate::transport::channels::CommandChannels;
use crate::transport::ipc::{endpoint, ActivationContext, Listener, Role};
use crate::transport::status::{LinkSnapshot, LinkStatus};

/// Owns the dispatcher, the channel endpoints, and the listener handle for one
/// bridge personality. Constructed in the node's `init`, wired up in
/// `enter_tree` via [`BridgeCore::start`], driven each frame by
/// [`BridgeCore::run_frame`], and torn down in `exit_tree` via
/// [`BridgeCore::stop`].
/// The IO-thread ends of the channels, taken by [`BridgeCore::start`] when it
/// spawns the listener.
struct ListenerEndpoints {
    inbound_tx: Sender<Command>,
    outbound_rx: Receiver<Response>,
    event_rx: Receiver<Vec<u8>>,
}

pub struct BridgeCore {
    role: Role,
    inbound_rx: Receiver<Command>,
    outbound_tx: Sender<Response>,
    event_tx: Sender<Vec<u8>>,
    listener_endpoints: Option<ListenerEndpoints>,
    dispatcher: Dispatcher,
    listener: Option<Listener>,
    link: LinkStatus,
    endpoint_display: Option<String>,
    bind_failed: bool,
}

impl BridgeCore {
    pub fn new(role: Role, registry: HandlerRegistry) -> Self {
        let channels = CommandChannels::default();
        let dispatcher = Dispatcher::new(registry, DrainBudget::default());
        BridgeCore {
            role,
            inbound_rx: channels.inbound_rx,
            outbound_tx: channels.outbound_tx,
            event_tx: channels.event_tx,
            listener_endpoints: Some(ListenerEndpoints {
                inbound_tx: channels.inbound_tx,
                outbound_rx: channels.outbound_rx,
                event_rx: channels.event_rx,
            }),
            dispatcher,
            listener: None,
            link: LinkStatus::default(),
            endpoint_display: None,
            bind_failed: false,
        }
    }

    /// A main-thread handle for emitting unsolicited event frames to the broker
    /// (whitepaper section 7.5). The debugger plugin holds one to report break
    /// and continue transitions.
    pub fn event_sender(&self) -> EventSender {
        EventSender::new(self.event_tx.clone())
    }

    /// Bind the listener if activation permits (whitepaper section 6.3). Safe to
    /// call once; a second call is a no-op because the endpoints are taken.
    pub fn start(&mut self) {
        let context = current_activation_context(self.role);
        if !context.should_bind() {
            godot_print!("Conduit ({}): listener not activated (release build or no opt-in)", self.role.as_str());
            return;
        }

        let Some(ListenerEndpoints { inbound_tx, outbound_rx, event_rx }) = self.listener_endpoints.take() else {
            return;
        };
        let project = project_path();
        let ep = endpoint(self.role, &project);
        self.endpoint_display = Some(ep.display().to_string());
        let hello = build_hello(self.role, &project).to_frame_payload();
        match Listener::spawn(ep, hello, inbound_tx, outbound_rx, event_rx, self.link.clone()) {
            Ok(listener) => {
                godot_print!("Conduit ({}): listening on {}", self.role.as_str(), listener.display());
                self.listener = Some(listener);
            }
            Err(err) => {
                self.bind_failed = true;
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
        // Safe to write from the main thread: stop() above joined the IO thread,
        // so no other writer exists (see transport::status).
        self.link.mark_inactive();
    }

    /// One consistent read of the broker-link state for the editor UI.
    pub fn link_snapshot(&self) -> LinkSnapshot {
        self.link.snapshot()
    }

    /// The endpoint this bridge listens on (recorded even when the bind failed).
    pub fn endpoint_display(&self) -> Option<&str> {
        self.endpoint_display.as_deref()
    }

    pub fn bind_failed(&self) -> bool {
        self.bind_failed
    }

    /// The dispatcher's completed-call ring, read by the editor panel.
    pub fn history(&self) -> &ToolHistory {
        self.dispatcher.history()
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
    let env_opt_in = crate::env::env_flag("CONDUIT_ENABLE");

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
