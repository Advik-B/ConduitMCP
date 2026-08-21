//! Engine log tailing, shared by the game bridge's incremental log and error
//! tools (whitepaper section 6.7) and the editor bridge's own pair. Both
//! processes have their own log file and their own independent read cursors;
//! this module is stateless, so each caller owns its offsets.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use godot::classes::ProjectSettings;
use godot::prelude::*;

/// The game process's own engine log path, from the project setting
/// (`user://logs/godot.log` unless reconfigured), globalized to an absolute
/// filesystem path. A game/export run writes it without being asked to.
pub(crate) fn game_log_path() -> String {
    let settings = ProjectSettings::singleton();
    let configured = settings.get_setting("debug/file_logging/log_path");
    let path = if configured.is_nil() { "user://logs/godot.log".to_string() } else { configured.to_string() };
    settings.globalize_path(&path).to_string()
}

/// The editor process's log path, if anything told it where that is.
///
/// The editor cannot discover this itself. `debug/file_logging/enable_file_logging`
/// is not honoured for `--editor` sessions, and the `--log-file` argument that
/// does work is consumed by the engine's own argument parsing and never appears
/// in `OS::get_cmdline_args()`, which reports only what the engine did not
/// recognise (measured in phase 21; `docs/api-gaps.md`). So whoever launched the
/// editor has to say, and `gd_editor_launch` sets `CONDUIT_LOG_FILE` to the same
/// path it passes to `--log-file`.
///
/// There is deliberately no fall back to `game_log_path()` here. That resolves
/// to where the *game* writes, so an editor read would answer with some earlier
/// game run's output, which is worse than answering nothing.
pub(crate) fn editor_log_path() -> Option<String> {
    match std::env::var("CONDUIT_LOG_FILE") {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

/// A slice of log read since a cursor.
pub(crate) struct LogSlice {
    pub text: String,
    /// Whether the slice was clipped to `max_bytes`; the tail is what is kept.
    pub truncated: bool,
    /// Where the next read should start.
    pub next_offset: u64,
}

/// Read the bytes appended to the log at `path` since `start_offset`.
///
/// An unopenable file is an error rather than an empty slice: "there is no log"
/// and "the log has nothing new" are different answers, and collapsing them is
/// how a diagnostic tool comes to report silence when it should report a
/// misconfiguration. Each caller decides which of the two its process makes
/// sense for.
pub(crate) fn read_log_range(path: &str, start_offset: u64, max_bytes: usize) -> io::Result<LogSlice> {
    let mut file = File::open(path)?;
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let mut start = start_offset;
    if start > len {
        // The log was rotated or truncated; restart from the beginning.
        start = 0;
    }
    if start >= len {
        return Ok(LogSlice { text: String::new(), truncated: false, next_offset: len });
    }
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buffer)?;

    let truncated = buffer.len() > max_bytes;
    if truncated {
        let tail_start = buffer.len() - max_bytes;
        buffer.drain(0..tail_start);
    }
    Ok(LogSlice { text: String::from_utf8_lossy(&buffer).into_owned(), truncated, next_offset: len })
}

#[cfg(test)]
mod tests {
    use super::editor_log_path;

    // The engine is not needed for this half: the editor's log path is whatever
    // the launcher said, and the interesting case is that it said nothing.
    #[test]
    fn an_unset_or_empty_variable_yields_no_editor_log() {
        let name = "CONDUIT_LOG_FILE";
        unsafe { std::env::remove_var(name) };
        assert_eq!(editor_log_path(), None);

        for value in ["", "   "] {
            unsafe { std::env::set_var(name, value) };
            assert_eq!(editor_log_path(), None, "expected {value:?} to name no log");
        }

        unsafe { std::env::set_var(name, "C:/tmp/editor.log") };
        assert_eq!(editor_log_path(), Some("C:/tmp/editor.log".to_string()));
        unsafe { std::env::remove_var(name) };
    }
}
