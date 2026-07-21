//! Pause, frame-stepping, waiting, and time-scale control (whitepaper sections
//! 6.4 and 6.6). Together these turn "pause, poke, step, observe" into a
//! first-class loop instead of a race against the frame clock.

use godot::classes::Engine;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::runtime::support::scene_tree;
use crate::protocol::BridgeError;

pub fn pause(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let paused = args.get("paused").and_then(Value::as_bool).unwrap_or(true);
        let mut tree = scene_tree()?;
        tree.set_pause(paused);
        Ok(json!({ "paused": paused }))
    })())
}

pub fn set_time_scale(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done((|| {
        let scale = args
            .get("scale")
            .and_then(Value::as_f64)
            .ok_or_else(|| BridgeError::InvalidArgs("'scale' is required and must be a number".into()))?;
        if scale < 0.0 {
            return Err(BridgeError::InvalidArgs("'scale' must not be negative".into()));
        }
        Engine::singleton().set_time_scale(scale);
        Ok(json!({ "time_scale": scale }))
    })())
}

/// Advance a paused game a precise number of frames. Unpause, count ticks in the
/// always-processing bridge, then restore the previous pause state.
pub fn step_frames(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let frames = match args.get("frames").and_then(Value::as_u64) {
        Some(frames) if frames >= 1 => frames,
        _ => {
            return HandlerOutcome::Done(Err(BridgeError::InvalidArgs(
                "'frames' must be an integer >= 1".into(),
            )));
        }
    };
    let mut tree = match scene_tree() {
        Ok(tree) => tree,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    let was_paused = tree.is_paused();
    tree.set_pause(false);
    HandlerOutcome::Pending(Box::new(StepFrames { remaining: frames, total: frames, was_paused }))
}

struct StepFrames {
    remaining: u64,
    total: u64,
    was_paused: bool,
}

impl PendingOp for StepFrames {
    fn poll(&mut self, _ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        self.remaining -= 1;
        if self.remaining > 0 {
            return None;
        }
        // Restore the pre-step pause state so a stepped-while-paused game stays
        // paused for the next inspection.
        if self.was_paused {
            match scene_tree() {
                Ok(mut tree) => tree.set_pause(true),
                Err(err) => return Some(Err(err)),
            }
        }
        Some(Ok(json!({ "stepped_frames": self.total, "was_paused": self.was_paused })))
    }
}

/// Wait a wall-clock-independent duration by accumulating rendered-frame deltas,
/// so the wait tracks the game's own time rather than the host clock.
pub fn wait_time(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    let seconds = match args.get("seconds").and_then(Value::as_f64) {
        Some(seconds) if seconds > 0.0 => seconds,
        _ => {
            return HandlerOutcome::Done(Err(BridgeError::InvalidArgs(
                "'seconds' must be a positive number".into(),
            )));
        }
    };
    HandlerOutcome::Pending(Box::new(WaitTime { remaining_ms: seconds * 1000.0, target_seconds: seconds }))
}

struct WaitTime {
    remaining_ms: f64,
    target_seconds: f64,
}

impl PendingOp for WaitTime {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        self.remaining_ms -= ctx.last_delta_ms;
        if self.remaining_ms > 0.0 {
            return None;
        }
        Some(Ok(json!({ "waited_seconds": self.target_seconds })))
    }
}
