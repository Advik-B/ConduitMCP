//! Conduit bridge: a Godot GDExtension that loads into the editor (and, from
//! phase 2, the game) process and executes broker commands on the main thread.
//!
//! Phase 1 scope: the skeleton and the dispatcher (whitepaper section 10). The
//! threading model of section 6.4 is the load-bearing part proven here.

pub mod dispatcher;
pub mod handlers;
pub mod protocol;
pub mod transport;
pub mod variant_json;

mod base64;
mod bridge_core;
mod log_tail;
mod plugin;
mod runtime_node;

use godot::prelude::*;

struct ConduitExtension;

#[gdextension]
unsafe impl ExtensionLibrary for ConduitExtension {}
