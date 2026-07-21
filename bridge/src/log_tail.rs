//! Engine log tailing, shared by the game bridge's incremental log/error tools
//! (whitepaper section 6.7) and the editor bridge's `gd_script_validate`
//! diagnostics. Both processes have their own log file and their own
//! independent read cursor; this module is stateless so each caller owns its
//! offset the way it needs to (a persistent per-stream cursor for `gd_get_logs`
//! /`gd_get_errors`, a fresh local cursor per call for `gd_script_validate`).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use godot::classes::ProjectSettings;
use godot::prelude::*;

/// The current process's own engine log path (`user://logs/godot.log` unless
/// reconfigured), globalized to an absolute filesystem path.
pub(crate) fn log_file_path() -> Option<String> {
    let settings = ProjectSettings::singleton();
    let configured = settings.get_setting("debug/file_logging/log_path");
    let path = if configured.is_nil() {
        "user://logs/godot.log".to_string()
    } else {
        configured.to_string()
    };
    Some(settings.globalize_path(&path).to_string())
}

/// Read the bytes appended to the log at `path` since `start_offset`. Returns
/// the new text, whether it was clipped to `max_bytes` (the tail is kept), and
/// the offset the next call should start from.
pub(crate) fn read_log_range(path: &str, start_offset: u64, max_bytes: usize) -> (String, bool, u64) {
    let Ok(mut file) = File::open(path) else {
        return (String::new(), false, start_offset);
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut start = start_offset;
    if start > len {
        // The log was rotated or truncated; restart from the beginning.
        start = 0;
    }
    if start >= len {
        return (String::new(), false, len);
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (String::new(), false, start_offset);
    }
    let mut buffer = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut buffer).is_err() {
        return (String::new(), false, start_offset);
    }

    let truncated = buffer.len() > max_bytes;
    if truncated {
        let tail_start = buffer.len() - max_bytes;
        buffer.drain(0..tail_start);
    }
    (String::from_utf8_lossy(&buffer).into_owned(), truncated, len)
}
