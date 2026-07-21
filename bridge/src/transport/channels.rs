//! Bounded inbound and unbounded outbound queues between the IO thread and the
//! main-thread dispatcher (whitepaper section 6.4).
//!
//! Inbound is bounded so a flood of requests applies backpressure rather than
//! growing memory without limit; when it is full the IO thread answers `busy`
//! immediately instead of blocking. Outbound is unbounded because every accepted
//! request must have somewhere to put its response; it is bounded in practice by
//! the number of requests in flight.

use crossbeam_channel::{bounded, unbounded, Receiver, Sender};

use crate::protocol::{Command, Response};

/// Default inbound capacity. Backpressure engages beyond this many queued
/// commands, which is what turns a burst into `busy` errors.
pub const DEFAULT_INBOUND_CAPACITY: usize = 256;

/// The endpoints wiring the IO thread to the dispatcher.
pub struct CommandChannels {
    /// IO thread pushes inbound commands here.
    pub inbound_tx: Sender<Command>,
    /// Dispatcher drains inbound commands from here on the main thread.
    pub inbound_rx: Receiver<Command>,
    /// Dispatcher pushes responses here on the main thread.
    pub outbound_tx: Sender<Response>,
    /// IO thread drains responses from here to write back to the broker.
    pub outbound_rx: Receiver<Response>,
    /// Main-thread emitters (e.g. the debugger plugin) push pre-serialised
    /// event-frame bytes here (whitepaper section 7.5). Unbounded and separate
    /// from responses so an id-less event never collides with id correlation.
    pub event_tx: Sender<Vec<u8>>,
    /// IO thread drains event bytes from here to write back to the broker.
    pub event_rx: Receiver<Vec<u8>>,
}

impl CommandChannels {
    pub fn new(inbound_capacity: usize) -> Self {
        let (inbound_tx, inbound_rx) = bounded::<Command>(inbound_capacity);
        let (outbound_tx, outbound_rx) = unbounded::<Response>();
        let (event_tx, event_rx) = unbounded::<Vec<u8>>();
        CommandChannels { inbound_tx, inbound_rx, outbound_tx, outbound_rx, event_tx, event_rx }
    }
}

impl Default for CommandChannels {
    fn default() -> Self {
        CommandChannels::new(DEFAULT_INBOUND_CAPACITY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::TrySendError;
    use serde_json::json;

    #[test]
    fn inbound_applies_backpressure_at_capacity() {
        let channels = CommandChannels::new(2);
        let cmd = |id| Command { id, tool: "gd_ping".into(), args: json!({}) };
        assert!(channels.inbound_tx.try_send(cmd(1)).is_ok());
        assert!(channels.inbound_tx.try_send(cmd(2)).is_ok());
        // Third send exceeds capacity and must fail rather than block or grow.
        match channels.inbound_tx.try_send(cmd(3)) {
            Err(TrySendError::Full(rejected)) => assert_eq!(rejected.id, 3),
            other => panic!("expected Full, got {other:?}"),
        }
    }
}
