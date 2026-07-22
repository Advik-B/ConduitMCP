//! Editor session lifecycle (whitepaper phase 9): `gd_editor_quit`.
//!
//! The quit is deferred, not immediate: the handler settles its response and
//! arms a schedule that fires only after both a frame count and a wall-clock
//! delay have elapsed, so the IO thread has flushed the response frame before
//! the process exits. The broker additionally treats the subsequent socket
//! close as confirmation, and holds a process handle to kill a hung editor.
//!
//! The quit itself is `SceneTree::quit()`: the editor's MainLoop is a
//! SceneTree, and quitting it bypasses the save-confirmation dialog the
//! window-close path would raise, matching the tool contract that unsaved
//! editor state is discarded. (An earlier double-stop bug in the IPC listener
//! made this look ignored; docs/api-gaps.md.) If the editor is somehow still
//! alive a grace period later, the bridge hard-kills its own process so a
//! headless session can never stall on shutdown.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use godot::classes::Os;
use godot::prelude::*;
use serde_json::{json, Value};

use crate::dispatcher::{FrameContext, HandlerOutcome};
use crate::handlers::runtime::support::scene_tree;

const FLUSH_DELAY_FRAMES: u64 = 5;
const FLUSH_DELAY: Duration = Duration::from_millis(250);
const GRACE_FRAMES: u64 = 30;
const GRACE_DELAY: Duration = Duration::from_secs(3);

thread_local! {
    static PENDING_QUIT: RefCell<Option<QuitPhase>> = const { RefCell::new(None) };
}

enum QuitPhase {
    /// Waiting for the response frame to flush before quitting.
    Flush(QuitSchedule),
    /// Quit requested; waiting before concluding the editor is stalled.
    Grace(QuitSchedule),
}

// Both conditions must hold before firing: frames prove the drain loop kept
// running (the IO thread had scheduler time), the wall clock covers a burst of
// fast frames outrunning the socket write.
struct QuitSchedule {
    frames_remaining: u64,
    armed_at: Instant,
    delay: Duration,
}

impl QuitSchedule {
    fn new(now: Instant, frames: u64, delay: Duration) -> Self {
        QuitSchedule { frames_remaining: frames, armed_at: now, delay }
    }

    fn tick(&mut self, now: Instant) -> bool {
        self.frames_remaining = self.frames_remaining.saturating_sub(1);
        self.frames_remaining == 0 && now.duration_since(self.armed_at) >= self.delay
    }
}

pub fn editor_quit(_args: &Value, _ctx: &FrameContext) -> HandlerOutcome {
    PENDING_QUIT.with(|slot| {
        *slot.borrow_mut() = Some(QuitPhase::Flush(QuitSchedule::new(Instant::now(), FLUSH_DELAY_FRAMES, FLUSH_DELAY)));
    });
    HandlerOutcome::Done(Ok(json!({ "quitting": true })))
}

/// Called once per frame from the editor plugin's `process`. Advances the armed
/// quit through its phases.
pub fn poll_deferred_quit() {
    enum Action {
        None,
        Quit,
        Kill,
    }
    let action = PENDING_QUIT.with(|slot| {
        let mut borrow = slot.borrow_mut();
        let now = Instant::now();
        match borrow.as_mut() {
            Some(QuitPhase::Flush(schedule)) => {
                if schedule.tick(now) {
                    *borrow = Some(QuitPhase::Grace(QuitSchedule::new(now, GRACE_FRAMES, GRACE_DELAY)));
                    Action::Quit
                } else {
                    Action::None
                }
            }
            Some(QuitPhase::Grace(schedule)) => {
                if schedule.tick(now) {
                    *borrow = None;
                    Action::Kill
                } else {
                    Action::None
                }
            }
            None => Action::None,
        }
    });
    match action {
        Action::None => {}
        Action::Quit => {
            if let Ok(mut tree) = scene_tree() {
                tree.quit();
            }
        }
        Action::Kill => {
            eprintln!("conduit: editor still running after quit request; killing own process");
            let mut os = Os::singleton();
            let pid = os.get_process_id();
            let _ = os.kill(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_schedule_requires_both_frames_and_wall_clock() {
        let start = Instant::now();
        let mut schedule = QuitSchedule::new(start, FLUSH_DELAY_FRAMES, FLUSH_DELAY);
        let late = start + FLUSH_DELAY;

        // Frames not yet elapsed, even long after the wall-clock delay.
        for _ in 0..FLUSH_DELAY_FRAMES - 1 {
            assert!(!schedule.tick(late));
        }
        // Frame budget met but clock not yet: still holds.
        let mut fast = QuitSchedule::new(start, FLUSH_DELAY_FRAMES, FLUSH_DELAY);
        for _ in 0..FLUSH_DELAY_FRAMES {
            assert!(!fast.tick(start));
        }
        // Both met: fires.
        assert!(schedule.tick(late));
    }
}
