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

type HandlerFn = fn(&Value, &FrameContext) -> HandlerOutcome;

pub struct HandlerRegistry {
    handlers: HashMap<&'static str, HandlerFn>,
}

impl HandlerRegistry {
    pub fn phase1() -> Self {
        let mut handlers: HashMap<&'static str, HandlerFn> = HashMap::new();
        handlers.insert("gd_ping", ping);
        handlers.insert("gd_wait_frames", wait_frames);
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
    fn wait_frames_suspends() {
        let registry = HandlerRegistry::phase1();
        let ctx = FrameContext { frame_index: 1, last_delta_ms: 16.0 };
        assert!(matches!(
            registry.dispatch("gd_wait_frames", &json!({"frames": 2}), &ctx),
            HandlerOutcome::Pending(_)
        ));
    }
}
