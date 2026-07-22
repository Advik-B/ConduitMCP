//! Broker-link state shared between the IO thread and the main thread.
//!
//! The editor UI (plugin.rs) polls this once per frame to drive the status
//! indicator. State (low 8 bits) and a connection generation (high 56 bits)
//! are packed into one `AtomicU64` so a snapshot is internally consistent
//! with a single load.
//!
//! Writer discipline: the IO thread owns the Listening and Connected
//! transitions; the main thread writes Inactive only in `BridgeCore::stop`
//! after `Listener::stop` has joined the IO thread. There is therefore never
//! a concurrent read-modify-write, and `Relaxed` ordering suffices because
//! the value guards no other data.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LinkState {
    /// Never bound, bind failed, or stopped.
    Inactive = 0,
    /// Bound and waiting for a broker connection.
    Listening = 1,
    /// A broker connection is live (hello frame written).
    Connected = 2,
}

impl LinkState {
    fn from_bits(bits: u8) -> LinkState {
        match bits {
            1 => LinkState::Listening,
            2 => LinkState::Connected,
            _ => LinkState::Inactive,
        }
    }
}

/// One consistent read of the link: the state plus how many connections have
/// ever been accepted. The generation bumps on every connect, so a
/// disconnect-and-reconnect between two polls is still observable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkSnapshot {
    pub state: LinkState,
    pub generation: u64,
}

impl Default for LinkSnapshot {
    fn default() -> Self {
        LinkSnapshot { state: LinkState::Inactive, generation: 0 }
    }
}

/// Cloneable handle to the shared link state. `BridgeCore` keeps one and hands
/// a clone to the listener's IO thread.
#[derive(Clone, Default)]
pub struct LinkStatus {
    inner: Arc<AtomicU64>,
}

impl LinkStatus {
    pub fn snapshot(&self) -> LinkSnapshot {
        let packed = self.inner.load(Ordering::Relaxed);
        LinkSnapshot { state: LinkState::from_bits(packed as u8), generation: packed >> 8 }
    }

    /// IO thread: after a successful bind, and after each served connection
    /// ends. Preserves the generation.
    pub(crate) fn mark_listening(&self) {
        let packed = self.inner.load(Ordering::Relaxed);
        self.inner.store((packed & !0xff) | LinkState::Listening as u64, Ordering::Relaxed);
    }

    /// IO thread: after the hello frame is written on a fresh connection.
    /// Bumps the generation so the main thread can reset connected-since even
    /// across a reconnect it never saw as a disconnect.
    pub(crate) fn mark_connected(&self) {
        let generation = (self.inner.load(Ordering::Relaxed) >> 8) + 1;
        self.inner.store((generation << 8) | LinkState::Connected as u64, Ordering::Relaxed);
    }

    /// Main thread only, after the IO thread has been joined.
    pub(crate) fn mark_inactive(&self) {
        let packed = self.inner.load(Ordering::Relaxed);
        self.inner.store(packed & !0xff, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_inactive_generation_zero() {
        let status = LinkStatus::default();
        assert_eq!(status.snapshot(), LinkSnapshot { state: LinkState::Inactive, generation: 0 });
    }

    #[test]
    fn connect_bumps_generation() {
        let status = LinkStatus::default();
        status.mark_listening();
        assert_eq!(status.snapshot(), LinkSnapshot { state: LinkState::Listening, generation: 0 });
        status.mark_connected();
        assert_eq!(status.snapshot(), LinkSnapshot { state: LinkState::Connected, generation: 1 });
        status.mark_connected();
        assert_eq!(status.snapshot().generation, 2);
    }

    #[test]
    fn disconnect_preserves_generation() {
        let status = LinkStatus::default();
        status.mark_listening();
        status.mark_connected();
        status.mark_listening();
        assert_eq!(status.snapshot(), LinkSnapshot { state: LinkState::Listening, generation: 1 });
        status.mark_inactive();
        assert_eq!(status.snapshot(), LinkSnapshot { state: LinkState::Inactive, generation: 1 });
    }

    #[test]
    fn state_bits_round_trip() {
        for state in [LinkState::Inactive, LinkState::Listening, LinkState::Connected] {
            assert_eq!(LinkState::from_bits(state as u8), state);
        }
    }
}
