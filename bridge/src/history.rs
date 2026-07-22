//! In-memory ring of completed tool calls, recorded by the dispatcher and read
//! by the editor UI (whitepaper section 6.10).
//!
//! Only the tool name and outcome are kept, never args or results, so memory
//! stays bounded and large payloads cannot leak into the panel. Records appear
//! in completion order with a monotonic sequence number, which lets the UI
//! append incrementally instead of rebuilding.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::protocol::Response;

pub const HISTORY_CAPACITY: usize = 200;

/// One completed tool call.
#[derive(Debug, Clone)]
pub struct ToolCallRecord {
    /// Monotonic completion counter; the UI's append cursor.
    pub seq: u64,
    pub tool: String,
    /// Wall-clock start, unix epoch milliseconds; the UI formats it.
    pub started_unix_ms: u64,
    /// Execute to response settle. For deferred (Pending) ops this is wall
    /// clock spanning frames, the time to complete, not handler CPU cost.
    pub duration: Duration,
    /// `None` for a successful call, the stable error code otherwise.
    pub error_code: Option<String>,
}

struct InFlight {
    tool: String,
    started: Instant,
    started_unix_ms: u64,
}

#[derive(Default)]
pub struct ToolHistory {
    completed: VecDeque<ToolCallRecord>,
    in_flight: HashMap<u64, InFlight>,
    next_seq: u64,
}

impl ToolHistory {
    /// Record that command `id` began executing. Called once per command in
    /// `Dispatcher::execute`, the only place the tool name is available.
    pub fn begin(&mut self, id: u64, tool: &str) {
        let started_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        self.in_flight
            .insert(id, InFlight { tool: tool.to_string(), started: Instant::now(), started_unix_ms });
    }

    /// Settle the record for `response.id`. A no-op for unknown ids: IO-side
    /// rejections (busy, malformed frames) never pass through the dispatcher.
    pub fn finish(&mut self, response: &Response) {
        let Some(entry) = self.in_flight.remove(&response.id) else {
            return;
        };
        self.next_seq += 1;
        self.completed.push_back(ToolCallRecord {
            seq: self.next_seq,
            tool: entry.tool,
            started_unix_ms: entry.started_unix_ms,
            duration: entry.started.elapsed(),
            error_code: response.error.as_ref().map(|error| error.code.clone()),
        });
        if self.completed.len() > HISTORY_CAPACITY {
            self.completed.pop_front();
        }
    }

    /// The seq of the newest completed record, 0 when none exist yet.
    pub fn latest_seq(&self) -> u64 {
        self.next_seq
    }

    /// Completed records newer than `seq`, oldest first.
    pub fn records_since(&self, seq: u64) -> impl Iterator<Item = &ToolCallRecord> {
        self.completed.iter().skip_while(move |record| record.seq <= seq)
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.len()
    }

    pub fn len(&self) -> usize {
        self.completed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.completed.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BridgeError;
    use serde_json::json;

    #[test]
    fn begin_finish_records_ok_call() {
        let mut history = ToolHistory::default();
        history.begin(7, "gd_ping");
        assert_eq!(history.in_flight_count(), 1);
        history.finish(&Response::ok(7, json!({})));
        assert_eq!(history.in_flight_count(), 0);
        assert_eq!(history.len(), 1);
        let record = history.records_since(0).next().expect("one record");
        assert_eq!(record.seq, 1);
        assert_eq!(record.tool, "gd_ping");
        assert!(record.error_code.is_none());
        assert!(record.started_unix_ms > 0);
    }

    #[test]
    fn failed_call_captures_error_code() {
        let mut history = ToolHistory::default();
        history.begin(1, "gd_missing");
        history.finish(&Response::failed(1, &BridgeError::UnknownTool("gd_missing".into())));
        let record = history.records_since(0).next().expect("one record");
        assert_eq!(record.error_code.as_deref(), Some("unknown_tool"));
    }

    #[test]
    fn deferred_settle_measures_elapsed_time() {
        let mut history = ToolHistory::default();
        history.begin(3, "gd_wait_frames");
        std::thread::sleep(Duration::from_millis(10));
        history.finish(&Response::ok(3, json!({})));
        let record = history.records_since(0).next().expect("one record");
        assert!(record.duration >= Duration::from_millis(10));
    }

    #[test]
    fn finish_unknown_id_is_noop() {
        let mut history = ToolHistory::default();
        history.finish(&Response::ok(42, json!({})));
        assert!(history.is_empty());
        assert_eq!(history.latest_seq(), 0);
    }

    #[test]
    fn eviction_keeps_seq_monotonic_and_drops_oldest() {
        let mut history = ToolHistory::default();
        for id in 0..(HISTORY_CAPACITY as u64 + 50) {
            history.begin(id, "gd_ping");
            history.finish(&Response::ok(id, json!({})));
        }
        assert_eq!(history.len(), HISTORY_CAPACITY);
        assert_eq!(history.latest_seq(), HISTORY_CAPACITY as u64 + 50);
        let first = history.records_since(0).next().expect("oldest record");
        assert_eq!(first.seq, 51);
    }

    #[test]
    fn records_since_cursor_semantics() {
        let mut history = ToolHistory::default();
        for id in 0..5 {
            history.begin(id, "gd_ping");
            history.finish(&Response::ok(id, json!({})));
        }
        assert_eq!(history.records_since(0).count(), 5);
        assert_eq!(history.records_since(3).count(), 2);
        assert_eq!(history.records_since(history.latest_seq()).count(), 0);
        let seqs: Vec<u64> = history.records_since(2).map(|record| record.seq).collect();
        assert_eq!(seqs, vec![3, 4, 5]);
    }
}
