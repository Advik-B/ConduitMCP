//! The editor bridge's half of the incremental log and error tail (whitepaper
//! section 6.7): the same mechanism as the game's `gd_get_logs` and
//! `gd_get_errors` (`runtime/observe.rs`) over a different file, with its own
//! two cursors.
//!
//! It exists because the engine's error convention is to print and return, so
//! an editor-side call that fails softly arrives at a client as a successful
//! tool call carrying a useless value -- phase 20's `RID(0)`, which is a
//! well-formed RID that names nothing. Without this the message explaining it
//! goes only to a stream no MCP client is attached to.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::log_tail;
use crate::protocol::BridgeError;

const DEFAULT_LOG_MAX_BYTES: usize = 64 * 1024;

/// Independent read offsets for the two tools, so polling for errors does not
/// consume the log stream. Touched only on the main thread.
static LOG_OFFSET: AtomicU64 = AtomicU64::new(0);
static ERROR_OFFSET: AtomicU64 = AtomicU64::new(0);

pub fn get_logs(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(
        read_new(&LOG_OFFSET, max_bytes(args))
            .map(|(text, truncated)| json!({ "logs": text, "truncated": truncated })),
    )
}

pub fn get_errors(args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    HandlerOutcome::Done(read_new(&ERROR_OFFSET, max_bytes(args)).map(|(text, truncated)| {
        let errors: Vec<&str> =
            text.lines().filter(|line| line.contains("ERROR") || line.contains("WARNING")).collect();
        json!({ "errors": errors, "truncated": truncated })
    }))
}

fn max_bytes(args: &Value) -> usize {
    args.get("max_bytes").and_then(Value::as_u64).map(|value| value as usize).unwrap_or(DEFAULT_LOG_MAX_BYTES)
}

/// Read what the editor's log gained since `offset`, advancing it.
///
/// Both failure modes are errors here, unlike the game's pair. For a running
/// game an absent log is transient and reads as "nothing new"; for the editor
/// it means nobody said where the log is, which no amount of waiting fixes, and
/// answering an empty list would be the same silence this tool exists to end.
fn read_new(offset: &AtomicU64, max_bytes: usize) -> Result<(String, bool), BridgeError> {
    let Some(path) = log_tail::editor_log_path() else {
        return Err(BridgeError::LogUnavailable(
            "the editor process is not writing a log file this bridge can find: CONDUIT_LOG_FILE is unset. \
             gd_editor_launch sets it alongside --log-file; an editor started by hand needs both, because \
             the engine consumes --log-file before OS.get_cmdline_args() can report it"
                .to_string(),
        ));
    };
    let start = offset.load(Ordering::Relaxed);
    match log_tail::read_log_range(&path, start, max_bytes) {
        Ok(slice) => {
            offset.store(slice.next_offset, Ordering::Relaxed);
            Ok((slice.text, slice.truncated))
        }
        Err(error) => Err(BridgeError::LogUnavailable(format!(
            "the editor log at {path} (CONDUIT_LOG_FILE) could not be read: {error}"
        ))),
    }
}
