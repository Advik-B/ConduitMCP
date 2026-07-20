//! Main-thread command execution with a per-frame budget and deferred
//! completion for suspending operations (whitepaper section 6.4).
//!
//! The dispatcher is engine-agnostic: it holds no gdext types and never calls
//! the engine. The plugin drives it once per frame from `_process`; the stress
//! harness drives it from a simulated loop. Everything here runs on one thread.

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use serde_json::Value;

use crate::handlers::HandlerRegistry;
use crate::protocol::{BridgeError, Command, Response};

/// Per-frame execution limits. Draining stops after `max_commands` commands or
/// `max_duration`, whichever comes first, so a burst of cheap commands cannot
/// hitch the frame and one expensive handler is confined to a single frame.
#[derive(Debug, Clone, Copy)]
pub struct DrainBudget {
    pub max_commands: usize,
    pub max_duration: Duration,
}

impl Default for DrainBudget {
    fn default() -> Self {
        // Whitepaper section 6.4 defaults: on the order of 32 commands and 4 ms.
        DrainBudget { max_commands: 32, max_duration: Duration::from_millis(4) }
    }
}

/// Read-only view of the current frame handed to handlers and pending ops.
#[derive(Debug, Clone, Copy)]
pub struct FrameContext {
    pub frame_index: u64,
    pub last_delta_ms: f64,
}

/// The result of invoking a handler: either settled immediately, or suspended
/// to complete in a later frame via a [`PendingOp`].
pub enum HandlerOutcome {
    Done(Result<Value, BridgeError>),
    Pending(Box<dyn PendingOp>),
}

/// A suspended operation polled once per frame until it settles. This is the
/// deferred-completion mechanism that lets an `await`-based command span frames
/// without blocking the main loop (whitepaper section 6.4).
pub trait PendingOp {
    /// Advance one frame. Return `Some` to settle (success or failure), `None`
    /// to remain pending. Runs on the main thread only; never blocks.
    fn poll(&mut self, ctx: &FrameContext) -> Option<Result<Value, BridgeError>>;
}

/// Aggregate counters exposed for the stress proof and diagnostics.
#[derive(Debug, Default, Clone, Copy)]
pub struct DispatchMetrics {
    pub frames_run: u64,
    pub commands_executed: u64,
    pub responses_emitted: u64,
    pub max_commands_in_frame: usize,
    pub max_drain_micros: u128,
    pub deferred_completed: u64,
}

/// Owns the handler registry, the pending-op set, and the frame counter.
pub struct Dispatcher {
    handlers: HandlerRegistry,
    budget: DrainBudget,
    pending: Vec<PendingEntry>,
    suspended_ids: HashSet<u64>,
    frame_index: u64,
    metrics: DispatchMetrics,
}

struct PendingEntry {
    id: u64,
    op: Box<dyn PendingOp>,
}

impl Dispatcher {
    pub fn new(handlers: HandlerRegistry, budget: DrainBudget) -> Self {
        Dispatcher {
            handlers,
            budget,
            pending: Vec::new(),
            suspended_ids: HashSet::new(),
            frame_index: 0,
            metrics: DispatchMetrics::default(),
        }
    }

    pub fn metrics(&self) -> DispatchMetrics {
        self.metrics
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Run one frame: advance pending ops, then drain new commands within the
    /// budget. `last_delta_ms` is the inter-frame gap reported to handlers.
    pub fn run_frame(
        &mut self,
        inbound: &Receiver<Command>,
        outbound: &Sender<Response>,
        last_delta_ms: f64,
    ) {
        self.frame_index += 1;
        self.metrics.frames_run += 1;
        let ctx = FrameContext { frame_index: self.frame_index, last_delta_ms };

        self.advance_pending(&ctx, outbound);
        self.drain_inbound(&ctx, inbound, outbound);
    }

    fn advance_pending(&mut self, ctx: &FrameContext, outbound: &Sender<Response>) {
        if self.pending.is_empty() {
            return;
        }
        // Move the pending set out so we can call `self.emit` while iterating.
        // Nothing else touches `self.pending` before we reassign it, because
        // command draining runs only after this pass.
        let entries = std::mem::take(&mut self.pending);
        let mut still_pending = Vec::with_capacity(entries.len());
        for mut entry in entries {
            let polled = catch_unwind(AssertUnwindSafe(|| entry.op.poll(ctx)));
            match polled {
                Ok(Some(result)) => {
                    self.suspended_ids.remove(&entry.id);
                    self.metrics.deferred_completed += 1;
                    self.emit(outbound, Response::from_result(entry.id, result));
                }
                Ok(None) => still_pending.push(entry),
                Err(_) => {
                    self.suspended_ids.remove(&entry.id);
                    self.emit(
                        outbound,
                        Response::failed(entry.id, &BridgeError::Internal("handler panicked while suspended".into())),
                    );
                }
            }
        }
        self.pending = still_pending;
    }

    fn drain_inbound(
        &mut self,
        ctx: &FrameContext,
        inbound: &Receiver<Command>,
        outbound: &Sender<Response>,
    ) {
        let start = Instant::now();
        let mut executed = 0usize;
        loop {
            if executed >= self.budget.max_commands {
                break;
            }
            if start.elapsed() >= self.budget.max_duration {
                break;
            }
            let command = match inbound.try_recv() {
                Ok(command) => command,
                Err(_) => break,
            };
            self.execute(ctx, command, outbound);
            executed += 1;
        }

        let drain_micros = start.elapsed().as_micros();
        self.metrics.commands_executed += executed as u64;
        if executed > self.metrics.max_commands_in_frame {
            self.metrics.max_commands_in_frame = executed;
        }
        if drain_micros > self.metrics.max_drain_micros {
            self.metrics.max_drain_micros = drain_micros;
        }
    }

    fn execute(&mut self, ctx: &FrameContext, command: Command, outbound: &Sender<Response>) {
        let Command { id, tool, args } = command;
        // Contain a handler panic so a single bad tool call degrades to one
        // error response rather than unwinding through the engine's frame call.
        let outcome = catch_unwind(AssertUnwindSafe(|| self.handlers.dispatch(&tool, &args, ctx)));
        match outcome {
            Ok(HandlerOutcome::Done(result)) => {
                self.emit(outbound, Response::from_result(id, result));
            }
            Ok(HandlerOutcome::Pending(op)) => {
                self.suspended_ids.insert(id);
                self.pending.push(PendingEntry { id, op });
            }
            Err(_) => {
                self.emit(outbound, Response::failed(id, &BridgeError::Internal("handler panicked".into())));
            }
        }
    }

    fn emit(&mut self, outbound: &Sender<Response>, response: Response) {
        // Outbound is unbounded; a send failure means the IO thread is gone,
        // in which case there is nothing to deliver to and dropping is correct.
        if outbound.send(response).is_ok() {
            self.metrics.responses_emitted += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::HandlerRegistry;
    use crossbeam_channel::{bounded, unbounded};
    use serde_json::json;

    fn setup() -> (Dispatcher, crossbeam_channel::Sender<Command>, crossbeam_channel::Receiver<Command>, crossbeam_channel::Sender<Response>, crossbeam_channel::Receiver<Response>)
    {
        let (in_tx, in_rx) = bounded::<Command>(256);
        let (out_tx, out_rx) = unbounded::<Response>();
        let dispatcher = Dispatcher::new(HandlerRegistry::phase1(), DrainBudget::default());
        (dispatcher, in_tx, in_rx, out_tx, out_rx)
    }

    #[test]
    fn ping_round_trips_with_id_correlation() {
        let (mut d, in_tx, in_rx, out_tx, out_rx) = setup();
        in_tx.send(Command { id: 99, tool: "gd_ping".into(), args: json!({}) }).unwrap();
        d.run_frame(&in_rx, &out_tx, 16.0);
        let resp = out_rx.recv().unwrap();
        assert_eq!(resp.id, 99);
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap()["pong"], true);
    }

    #[test]
    fn unknown_tool_yields_structured_error() {
        let (mut d, in_tx, in_rx, out_tx, out_rx) = setup();
        in_tx.send(Command { id: 1, tool: "gd_nope".into(), args: json!({}) }).unwrap();
        d.run_frame(&in_rx, &out_tx, 16.0);
        let resp = out_rx.recv().unwrap();
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "unknown_tool");
    }

    #[test]
    fn drain_respects_command_budget() {
        let budget = DrainBudget { max_commands: 8, max_duration: Duration::from_secs(1) };
        let (in_tx, in_rx) = bounded::<Command>(1024);
        let (out_tx, out_rx) = unbounded::<Response>();
        let mut d = Dispatcher::new(HandlerRegistry::phase1(), budget);
        for id in 0..50 {
            in_tx.send(Command { id, tool: "gd_ping".into(), args: json!({}) }).unwrap();
        }
        d.run_frame(&in_rx, &out_tx, 16.0);
        // At most `max_commands` execute in one frame.
        assert_eq!(out_rx.len(), 8);
        assert_eq!(d.metrics().max_commands_in_frame, 8);
    }

    #[test]
    fn wait_frames_completes_via_deferred_resolution_after_exactly_n_frames() {
        let (mut d, in_tx, in_rx, out_tx, out_rx) = setup();
        in_tx.send(Command { id: 5, tool: "gd_wait_frames".into(), args: json!({"frames": 3}) }).unwrap();

        // Frame 1: command drained and registered pending. The op is polled
        // only from the next frame on, so completion lands N frames after this
        // draining frame: one draining frame plus N poll frames.
        d.run_frame(&in_rx, &out_tx, 16.0);
        assert!(out_rx.is_empty());
        assert_eq!(d.pending_count(), 1);

        // Frames 2 and 3: two of the three polls (3 -> 2 -> 1), still pending.
        d.run_frame(&in_rx, &out_tx, 16.0);
        assert!(out_rx.is_empty());
        d.run_frame(&in_rx, &out_tx, 16.0);
        assert!(out_rx.is_empty());

        // Frame 4: the third poll (1 -> 0) settles, exactly 3 frames after drain.
        d.run_frame(&in_rx, &out_tx, 16.0);
        let resp = out_rx.recv().unwrap();
        assert_eq!(resp.id, 5);
        assert!(resp.ok);
        let result = resp.result.unwrap();
        assert_eq!(result["waited_frames"], 3);
        let submitted = result["submitted_frame"].as_u64().unwrap();
        let completed = result["completed_frame"].as_u64().unwrap();
        assert_eq!(completed - submitted, 3);
        assert_eq!(d.metrics().deferred_completed, 1);
    }

    #[test]
    fn invalid_wait_frames_argument_fails_fast() {
        let (mut d, in_tx, in_rx, out_tx, out_rx) = setup();
        in_tx.send(Command { id: 2, tool: "gd_wait_frames".into(), args: json!({"frames": 0}) }).unwrap();
        d.run_frame(&in_rx, &out_tx, 16.0);
        let resp = out_rx.recv().unwrap();
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, "invalid_args");
    }
}
