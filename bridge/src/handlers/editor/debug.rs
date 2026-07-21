//! The consolidated `gd_debug` tool (whitepaper sections 6.9 and 7.1).
//!
//! One tool with an `op` discriminator covers breakpoints, execution control,
//! and stack/variable inspection. Breakpoint ops are immediate and operate on
//! the bridge-side list in `debugger.rs`. Execution-control ops send a message
//! to the game's script debugger and settle via a `PendingOp` when the session's
//! break state transitions. Stack and vars read the editor's debugger dock,
//! which is the tier-2 fallback section 6.9 sanctions because the core debugger
//! replies are not observable from the plugin.

use serde_json::{json, Value};

use crate::debugger;
use crate::dispatcher::{FrameContext, HandlerOutcome, PendingOp};
use crate::handlers::args::{optional_bool, optional_u64, require_str};
use crate::handlers::editor::support::validate_project_path;
use crate::protocol::BridgeError;

/// Frames a break/continue/step waits for the session state to transition before
/// giving up. Generous: a break waits for the game to reach the next statement.
const TRANSITION_DEADLINE_FRAMES: u64 = 600;
/// Frames a stack/vars read waits for the debugger dock to populate after break.
/// The editor throttles its tick rate while a game is halted, so this is counted
/// generously in frames; the broker's await timeout bounds it in wall-clock.
const DOCK_DEADLINE_FRAMES: u64 = 1800;

pub fn debug(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let op = match require_str(args, "op") {
        Ok(op) => op,
        Err(err) => return HandlerOutcome::Done(Err(err)),
    };
    match op.as_str() {
        "set_breakpoint" => HandlerOutcome::Done(set_breakpoint(args)),
        "clear_breakpoint" => HandlerOutcome::Done(clear_breakpoint(args)),
        "list_breakpoints" => HandlerOutcome::Done(Ok(json!({ "breakpoints": debugger::breakpoints_json() }))),
        "break" => transition(Target::Breaked, ctx),
        "continue" => transition(Target::Continued, ctx),
        "step_over" => step(StepKind::Over, ctx),
        "step_into" => step(StepKind::Into, ctx),
        "stack" => stack(args, ctx),
        "vars" => vars(args, ctx),
        other => HandlerOutcome::Done(Err(BridgeError::InvalidArgs(format!(
            "unknown gd_debug op '{other}'; expected one of set_breakpoint, clear_breakpoint, list_breakpoints, break, continue, step_over, step_into, stack, vars"
        )))),
    }
}

fn set_breakpoint(args: &Value) -> Result<Value, BridgeError> {
    let path = require_str(args, "path")?;
    validate_project_path(&path)?;
    let line = require_line(args)?;
    let added = debugger::add_breakpoint(&path, line);
    Ok(json!({ "set": true, "path": path, "line": line, "added": added }))
}

fn clear_breakpoint(args: &Value) -> Result<Value, BridgeError> {
    if optional_bool(args, "all").unwrap_or(false) {
        let removed = debugger::clear_breakpoints();
        return Ok(json!({ "cleared": true, "removed": removed }));
    }
    let path = require_str(args, "path")?;
    validate_project_path(&path)?;
    let line = optional_u64(args, "line").map(|line| line as u32);
    let removed = debugger::remove_breakpoint(&path, line);
    Ok(json!({ "cleared": true, "path": path, "line": line, "removed": removed }))
}

fn require_line(args: &Value) -> Result<u32, BridgeError> {
    match optional_u64(args, "line") {
        Some(line) if line >= 1 => Ok(line as u32),
        _ => Err(BridgeError::InvalidArgs("'line' is required and must be an integer >= 1 (1-based)".into())),
    }
}

#[derive(Clone, Copy)]
enum Target {
    Breaked,
    Continued,
}

fn transition(target: Target, ctx: &FrameContext) -> HandlerOutcome {
    // `break` needs an active session; `continue` needs a breaked one.
    let session_id = match target {
        Target::Breaked => match debugger::any_active_session() {
            Some(id) => id,
            None => return HandlerOutcome::Done(Err(no_session())),
        },
        Target::Continued => match debugger::breaked_session() {
            Some(id) => id,
            None => return HandlerOutcome::Done(Err(not_breaked("continue"))),
        },
    };

    // `break` on an already-breaked session is a no-op success.
    if matches!(target, Target::Breaked) && debugger::is_breaked(session_id) {
        return HandlerOutcome::Done(Ok(json!({ "breaked": true, "already_breaked": true })));
    }

    let message = match target {
        Target::Breaked => "break",
        Target::Continued => "continue",
    };
    if let Err(err) = send(session_id, message) {
        return HandlerOutcome::Done(Err(err));
    }

    HandlerOutcome::Pending(Box::new(TransitionPending {
        session_id,
        want_breaked: matches!(target, Target::Breaked),
        start_generation: debugger::break_generation(),
        stepping: false,
        deadline_frame: ctx.frame_index.saturating_add(TRANSITION_DEADLINE_FRAMES),
    }))
}

#[derive(Clone, Copy)]
enum StepKind {
    Over,
    Into,
}

fn step(kind: StepKind, ctx: &FrameContext) -> HandlerOutcome {
    let session_id = match debugger::breaked_session() {
        Some(id) => id,
        None => return HandlerOutcome::Done(Err(not_breaked("step"))),
    };
    let message = match kind {
        StepKind::Over => "next",
        StepKind::Into => "step",
    };
    // A step continues then re-breaks at the next line, so the session ends
    // breaked either way; the generation bump on the re-break is what tells us
    // the step landed rather than the pre-existing break being observed.
    let start_generation = debugger::break_generation();
    if let Err(err) = send(session_id, message) {
        return HandlerOutcome::Done(Err(err));
    }
    HandlerOutcome::Pending(Box::new(TransitionPending {
        session_id,
        want_breaked: true,
        start_generation,
        stepping: true,
        deadline_frame: ctx.frame_index.saturating_add(TRANSITION_DEADLINE_FRAMES),
    }))
}

fn send(session_id: i32, message: &str) -> Result<(), BridgeError> {
    match debugger::session(session_id) {
        Some(mut session) => {
            session.send_message(message);
            Ok(())
        }
        None => Err(no_session()),
    }
}

struct TransitionPending {
    session_id: i32,
    want_breaked: bool,
    start_generation: u64,
    stepping: bool,
    deadline_frame: u64,
}

impl PendingOp for TransitionPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if !debugger::is_active(self.session_id) {
            return Some(Err(BridgeError::NoDebugSession(
                "the debug session ended while waiting for the operation to settle".into(),
            )));
        }
        let breaked = debugger::is_breaked(self.session_id);
        if self.stepping {
            // Settle only once a fresh break has occurred, so we do not report
            // the break we stepped away from.
            if breaked && debugger::break_generation() > self.start_generation {
                return Some(Ok(json!({ "breaked": true, "stepped": true })));
            }
        } else if self.want_breaked {
            if breaked {
                return Some(Ok(json!({ "breaked": true })));
            }
        } else if !breaked {
            return Some(Ok(json!({ "breaked": false })));
        }

        if ctx.frame_index >= self.deadline_frame {
            let message = if self.stepping {
                "step did not re-break before the deadline; the frame may have returned into native code, so use gd_debug op break"
            } else if self.want_breaked {
                "the game did not break before the deadline; it may be idle in native code with no script statement to break on"
            } else {
                "the game did not resume before the deadline"
            };
            return Some(Err(BridgeError::CallFailed(message.into())));
        }
        None
    }
}

fn stack(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let session_id = match debugger::breaked_session() {
        Some(id) => id,
        None => return HandlerOutcome::Done(Err(not_breaked("stack"))),
    };
    let frame_limit = optional_u64(args, "frame_limit").map(|value| value as usize);
    HandlerOutcome::Pending(Box::new(DockReadPending {
        session_id,
        read: DockRead::Stack { frame_limit },
        deadline_frame: ctx.frame_index.saturating_add(DOCK_DEADLINE_FRAMES),
    }))
}

fn vars(args: &Value, ctx: &FrameContext) -> HandlerOutcome {
    let session_id = match debugger::breaked_session() {
        Some(id) => id,
        None => return HandlerOutcome::Done(Err(not_breaked("vars"))),
    };
    let frame = optional_u64(args, "frame").unwrap_or(0) as usize;
    HandlerOutcome::Pending(Box::new(DockReadPending {
        session_id,
        read: DockRead::Vars { frame, selected: false, settle_countdown: 0 },
        deadline_frame: ctx.frame_index.saturating_add(DOCK_DEADLINE_FRAMES),
    }))
}

enum DockRead {
    Stack { frame_limit: Option<usize> },
    Vars { frame: usize, selected: bool, settle_countdown: u32 },
}

struct DockReadPending {
    session_id: i32,
    read: DockRead,
    deadline_frame: u64,
}

impl PendingOp for DockReadPending {
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>> {
        if !debugger::is_breaked(self.session_id) {
            return Some(Err(BridgeError::NotBreaked(
                "the session resumed before the debugger dock could be read".into(),
            )));
        }
        let settled = match &mut self.read {
            DockRead::Stack { frame_limit } => debugger::read_stack(*frame_limit),
            DockRead::Vars { frame, selected, settle_countdown } => {
                debugger::read_vars(*frame, selected, settle_countdown)
            }
        };
        match settled {
            Some(result) => Some(result),
            None => {
                if ctx.frame_index >= self.deadline_frame {
                    Some(Err(BridgeError::CallFailed(
                        "the debugger dock did not populate before the deadline; see docs/api-gaps.md".into(),
                    )))
                } else {
                    None
                }
            }
        }
    }
}

fn no_session() -> BridgeError {
    BridgeError::NoDebugSession(
        "no game is connected to the debugger; launch the game with gd_play from this editor first".into(),
    )
}

fn not_breaked(op: &str) -> BridgeError {
    BridgeError::NotBreaked(format!(
        "gd_debug op '{op}' requires the game to be halted at a breakpoint; set a breakpoint and trigger it, or use gd_debug op break"
    ))
}
