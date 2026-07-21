//! Editor-side debugger integration (whitepaper section 6.9).
//!
//! `ConduitDebuggerPlugin` is an `EditorDebuggerPlugin` registered by the editor
//! bridge in `plugin.rs`. The engine hands it an `EditorDebuggerSession` per
//! running game; the plugin connects each session's lifecycle signals and
//! mirrors the break/continue state into a main-thread `DEBUG_STATE`, emitting an
//! event frame on every transition so the broker can surface `game_breaked`.
//!
//! The `gd_debug` handlers (`handlers/editor/debug.rs`) have no `self`, so they
//! reach the live session through the plugin instance stashed in `DEBUG_STATE`.
//! Everything here runs on the main thread: the signal callbacks fire during the
//! engine's debugger processing and the handlers run in the dispatcher drain, so
//! a plain `thread_local! RefCell` is sufficient and no locking is needed.
//!
//! Core debugger replies (`stack_dump`, `stack_frame_vars`) are not observable
//! from `EditorDebuggerPlugin::capture` (it only receives prefix-namespaced
//! messages), so stack and variable reads walk the editor's debugger dock
//! instead, the tier-2 fallback section 6.9 sanctions. Those dock helpers live
//! here so all debugger-UI coupling is in one module.

use std::cell::RefCell;
use std::collections::HashMap;

use godot::classes::{EditorDebuggerPlugin, EditorInspector, EditorInterface, IEditorDebuggerPlugin, Node, Os, Tree, TreeItem};
use godot::prelude::*;
use serde_json::{json, Value};

use crate::protocol::BridgeError;
use crate::protocol::EventSender;
use crate::variant_json::variant_to_json;

/// Per-variable value byte cap for the vars read, so a large local cannot flood
/// the response; truncation is explicit (whitepaper section 7.6).
const VAR_VALUE_MAX_BYTES: usize = 2048;

/// One breakpoint the agent has set. Lines are 1-based, matching the script
/// editor gutter and the `gd_debug` tool contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Breakpoint {
    pub path: String,
    pub line: u32,
}

/// The bridge-side breakpoint registry (whitepaper section 6.9: the list is
/// maintained here so it can be reported and re-applied without engine support).
/// Engine-free so it is unit-testable without Godot.
#[derive(Debug, Default)]
pub struct BreakpointList {
    entries: Vec<Breakpoint>,
}

impl BreakpointList {
    /// Add a breakpoint, ignoring an exact duplicate. Returns whether it was new.
    pub fn add(&mut self, path: &str, line: u32) -> bool {
        let bp = Breakpoint { path: path.to_string(), line };
        if self.entries.contains(&bp) {
            return false;
        }
        self.entries.push(bp);
        true
    }

    /// Remove one breakpoint by path and line. Returns whether one was removed.
    pub fn remove(&mut self, path: &str, line: u32) -> bool {
        let before = self.entries.len();
        self.entries.retain(|bp| !(bp.path == path && bp.line == line));
        self.entries.len() != before
    }

    /// Remove every breakpoint in a file. Returns how many were removed.
    pub fn remove_path(&mut self, path: &str) -> usize {
        let before = self.entries.len();
        self.entries.retain(|bp| bp.path != path);
        before - self.entries.len()
    }

    pub fn clear(&mut self) -> usize {
        let count = self.entries.len();
        self.entries.clear();
        count
    }

    pub fn iter(&self) -> impl Iterator<Item = &Breakpoint> {
        self.entries.iter()
    }

    pub fn to_json(&self) -> Value {
        Value::Array(
            self.entries
                .iter()
                .map(|bp| json!({ "path": bp.path, "line": bp.line }))
                .collect(),
        )
    }
}

/// Break state for one debug session, mirrored from its lifecycle signals.
#[derive(Debug, Default, Clone, Copy)]
pub struct SessionState {
    pub active: bool,
    pub breaked: bool,
    pub can_debug: bool,
}

/// Main-thread debugger state shared between the plugin and the handlers.
#[derive(Default)]
struct DebugState {
    plugin: Option<Gd<ConduitDebuggerPlugin>>,
    sessions: HashMap<i32, SessionState>,
    breakpoints: BreakpointList,
    /// Bumped on every break, so a step (continue then re-break) is detectable
    /// as a generation change even though the session ends breaked either way.
    break_generation: u64,
    events: Option<EventSender>,
    /// While a game is halted the editor drops to its idle tick rate, which
    /// starves the pending-op polling that reads the debugger dock. We disable
    /// low-processor mode for the duration of a break and restore the prior value
    /// on resume; `Some(prev)` means the override is currently active.
    low_processor_override: Option<bool>,
}

thread_local! {
    static DEBUG_STATE: RefCell<DebugState> = RefCell::new(DebugState::default());
}

fn with_state<R>(f: impl FnOnce(&mut DebugState) -> R) -> R {
    DEBUG_STATE.with(|state| f(&mut state.borrow_mut()))
}

/// Install the plugin's shared state. Called once as the editor bridge registers
/// the plugin; the returned `Gd` is what `add_debugger_plugin` receives.
pub fn install(events: EventSender) -> Gd<ConduitDebuggerPlugin> {
    let plugin = ConduitDebuggerPlugin::new_gd();
    with_state(|state| {
        state.events = Some(events);
        state.plugin = Some(plugin.clone());
    });
    plugin
}

/// Tear down the shared state, dropping the plugin reference so no cycle keeps it
/// alive after the editor bridge leaves the tree.
pub fn uninstall() {
    restore_responsiveness();
    with_state(|state| {
        state.plugin = None;
        state.events = None;
        state.sessions.clear();
        state.breakpoints.clear();
    });
}

/// The session with the given id, reached through the stored plugin. Handlers use
/// this because they have no `self`.
pub(crate) fn session(session_id: i32) -> Option<Gd<godot::classes::EditorDebuggerSession>> {
    with_state(|state| state.plugin.as_ref().and_then(|plugin| plugin.bind().base().get_session(session_id)))
}

/// A session that is currently active (a game attached to the debugger). Prefers
/// the breaked one so execution-control ops target the session an agent means.
pub(crate) fn any_active_session() -> Option<i32> {
    with_state(|state| {
        state
            .sessions
            .iter()
            .find(|(_, s)| s.active && s.breaked)
            .or_else(|| state.sessions.iter().find(|(_, s)| s.active))
            .map(|(id, _)| *id)
    })
}

/// The session currently halted at a breakpoint, if any.
pub(crate) fn breaked_session() -> Option<i32> {
    with_state(|state| state.sessions.iter().find(|(_, s)| s.active && s.breaked).map(|(id, _)| *id))
}

pub(crate) fn is_breaked(session_id: i32) -> bool {
    with_state(|state| state.sessions.get(&session_id).map(|s| s.breaked).unwrap_or(false))
}

pub(crate) fn is_active(session_id: i32) -> bool {
    with_state(|state| state.sessions.get(&session_id).map(|s| s.active).unwrap_or(false))
}

pub(crate) fn break_generation() -> u64 {
    with_state(|state| state.break_generation)
}

/// Snapshot of every known session's state, for `gd_editor_get_state`.
pub(crate) fn sessions_json() -> Value {
    with_state(|state| {
        Value::Array(
            state
                .sessions
                .iter()
                .map(|(id, s)| json!({ "id": id, "active": s.active, "breaked": s.breaked, "can_debug": s.can_debug }))
                .collect(),
        )
    })
}

pub(crate) fn breakpoints_json() -> Value {
    with_state(|state| state.breakpoints.to_json())
}

/// Record a breakpoint and apply it to every active session. Returns whether it
/// was newly added to the bridge-side list.
pub(crate) fn add_breakpoint(path: &str, line: u32) -> bool {
    let added = with_state(|state| state.breakpoints.add(path, line));
    apply_breakpoint_to_active(path, line, true);
    added
}

/// Remove one breakpoint (or, when `line` is `None`, every breakpoint in the
/// file) from the list and disable it on active sessions. Returns how many list
/// entries were removed.
pub(crate) fn remove_breakpoint(path: &str, line: Option<u32>) -> usize {
    // Capture the exact lines being removed first, so each can be disabled on a
    // live session even for the whole-file case.
    let disabled_lines: Vec<u32> = with_state(|state| {
        state
            .breakpoints
            .iter()
            .filter(|bp| bp.path == path && line.is_none_or(|l| bp.line == l))
            .map(|bp| bp.line)
            .collect()
    });
    let removed = with_state(|state| match line {
        Some(line) => usize::from(state.breakpoints.remove(path, line)),
        None => state.breakpoints.remove_path(path),
    });
    for l in disabled_lines {
        apply_breakpoint_to_active(path, l, false);
    }
    removed
}

/// Clear every breakpoint from the list and disable them all on active sessions.
pub(crate) fn clear_breakpoints() -> usize {
    let (removed, drained) = with_state(|state| {
        let drained: Vec<Breakpoint> = state.breakpoints.iter().cloned().collect();
        let removed = state.breakpoints.clear();
        (removed, drained)
    });
    for bp in drained {
        apply_breakpoint_to_active(&bp.path, bp.line, false);
    }
    removed
}

fn apply_breakpoint_to_active(path: &str, line: u32, enabled: bool) {
    let ids: Vec<i32> = with_state(|state| {
        state.sessions.iter().filter(|(_, s)| s.active).map(|(id, _)| *id).collect()
    });
    for id in ids {
        if let Some(mut session) = session(id) {
            session.set_breakpoint(path, line as i32, enabled);
        }
    }
}

fn emit_event(event: &str, data: Value) {
    with_state(|state| {
        if let Some(events) = &state.events {
            events.send(event, data);
        }
    });
}

fn mark_started(session_id: i32) {
    with_state(|state| {
        let entry = state.sessions.entry(session_id).or_default();
        entry.active = true;
        entry.breaked = false;
    });
    emit_event("debug_session_started", json!({ "session_id": session_id }));
}

fn mark_stopped(session_id: i32) {
    let any_breaked = with_state(|state| {
        let entry = state.sessions.entry(session_id).or_default();
        entry.active = false;
        entry.breaked = false;
        state.sessions.values().any(|s| s.breaked)
    });
    if !any_breaked {
        restore_responsiveness();
    }
    emit_event("debug_session_stopped", json!({ "session_id": session_id }));
}

fn mark_breaked(session_id: i32, can_debug: bool) {
    with_state(|state| {
        let entry = state.sessions.entry(session_id).or_default();
        entry.active = true;
        entry.breaked = true;
        entry.can_debug = can_debug;
        state.break_generation += 1;
    });
    enable_responsiveness();
    emit_event("debug_breaked", json!({ "session_id": session_id, "can_debug": can_debug }));
}

fn mark_continued(session_id: i32) {
    let any_breaked = with_state(|state| {
        if let Some(entry) = state.sessions.get_mut(&session_id) {
            entry.breaked = false;
        }
        state.sessions.values().any(|s| s.breaked)
    });
    if !any_breaked {
        restore_responsiveness();
    }
    emit_event("debug_continued", json!({ "session_id": session_id }));
}

/// Keep the editor at full tick rate for the duration of a break, saving the
/// prior low-processor setting so it can be restored on resume.
fn enable_responsiveness() {
    with_state(|state| {
        if state.low_processor_override.is_none() {
            state.low_processor_override = Some(Os::singleton().is_in_low_processor_usage_mode());
        }
    });
    apply_full_speed();
}

/// Force the editor main loop not to sleep. Called every frame while breaked
/// because the editor re-applies its unfocused throttle (a long idle sleep) on
/// window-focus churn, which under a virtual display happens repeatedly and
/// would otherwise starve the pending-op polling that reads the debugger dock.
fn apply_full_speed() {
    let mut os = Os::singleton();
    os.set_low_processor_usage_mode(false);
    os.set_low_processor_usage_mode_sleep_usec(1000);
}

/// Re-assert full-speed processing if a break is in progress. Driven once per
/// frame by the editor plugin so the override survives the editor's own churn.
pub(crate) fn keep_editor_responsive() {
    let overriding = with_state(|state| state.low_processor_override.is_some());
    if overriding {
        apply_full_speed();
    }
}

fn restore_responsiveness() {
    with_state(|state| {
        if let Some(prev) = state.low_processor_override.take() {
            Os::singleton().set_low_processor_usage_mode(prev);
        }
    });
}

/// The editor-side debugger plugin. One instance is registered for the editor's
/// lifetime; `setup_session` runs per launched game.
#[derive(GodotClass)]
#[class(tool, base = EditorDebuggerPlugin)]
pub struct ConduitDebuggerPlugin {
    base: Base<EditorDebuggerPlugin>,
}

#[godot_api]
impl IEditorDebuggerPlugin for ConduitDebuggerPlugin {
    fn init(base: Base<EditorDebuggerPlugin>) -> Self {
        ConduitDebuggerPlugin { base }
    }

    fn setup_session(&mut self, session_id: i32) {
        let Some(mut session) = self.base().get_session(session_id) else {
            return;
        };
        let this = self.to_gd();
        let bind = |method: &str| {
            Callable::from_object_method(&this, method).bind(&[session_id.to_variant()])
        };
        session.connect("started", &bind("on_session_started"));
        session.connect("stopped", &bind("on_session_stopped"));
        session.connect("breaked", &bind("on_session_breaked"));
        session.connect("continued", &bind("on_session_continued"));
    }

    // The engine asks every plugin whether it handles a capture prefix before
    // routing a message. We handle none; both must be overridden or the default
    // bodies panic.
    fn has_capture(&self, _capture: GString) -> bool {
        false
    }

    fn capture(&mut self, _message: GString, _data: VarArray, _session_id: i32) -> bool {
        false
    }
}

#[godot_api]
impl ConduitDebuggerPlugin {
    #[func]
    fn on_session_started(&mut self, session_id: i32) {
        // Re-apply every stored breakpoint to the freshly started session, so
        // breakpoints set before launch take effect (whitepaper section 6.9).
        if let Some(mut session) = self.base().get_session(session_id) {
            let entries: Vec<Breakpoint> = with_state(|state| state.breakpoints.iter().cloned().collect());
            for bp in entries {
                session.set_breakpoint(&bp.path, bp.line as i32, true);
            }
        }
        mark_started(session_id);
    }

    #[func]
    fn on_session_stopped(&mut self, session_id: i32) {
        mark_stopped(session_id);
    }

    #[func]
    fn on_session_breaked(&mut self, can_debug: bool, session_id: i32) {
        mark_breaked(session_id, can_debug);
    }

    #[func]
    fn on_session_continued(&mut self, session_id: i32) {
        mark_continued(session_id);
    }
}

/// The editor's `ScriptEditorDebugger` dock, the source for stack and vars reads.
fn script_editor_debugger() -> Option<Gd<Node>> {
    let base = EditorInterface::singleton().get_base_control()?;
    base.find_children_ex("*")
        .type_("ScriptEditorDebugger")
        .recursive(true)
        .owned(false)
        .done()
        .iter_shared()
        .next()
}

/// The call-stack `Tree` inside the dock: the one whose root children carry
/// stack metadata (a Dictionary with `file`/`line`/`frame`) or stack-shaped text.
fn stack_tree(dock: &Gd<Node>) -> Option<Gd<Tree>> {
    let trees = dock.find_children_ex("*").type_("Tree").recursive(true).owned(false).done();
    for tree in trees.iter_shared() {
        let tree: Gd<Tree> = tree.cast();
        if let Some(root) = tree.get_root()
            && (stack_frame(&root, 0).is_some() || root.get_child(0).and_then(|c| stack_frame(&c, 0)).is_some())
        {
            return Some(tree);
        }
    }
    None
}

/// Parse one stack frame from a tree item, from its column-0 metadata Dictionary
/// (`frame`/`file`/`line`) with a fallback to parsing the item text.
fn stack_frame(item: &Gd<TreeItem>, index: usize) -> Option<Value> {
    let metadata = item.get_metadata(0);
    if let Ok(dict) = metadata.try_to::<VarDictionary>() {
        let file = dict.get(&GString::from("file")).map(|v| v.stringify().to_string());
        let line = dict.get(&GString::from("line")).and_then(|v| v.try_to::<i64>().ok());
        let function = dict
            .get(&GString::from("function"))
            .or_else(|| dict.get(&GString::from("func")))
            .map(|v| v.stringify().to_string());
        if file.is_some() || line.is_some() {
            return Some(json!({
                "index": index,
                "function": function,
                "file": file,
                "line": line,
            }));
        }
    }
    let text = item.get_text(0).to_string();
    if text.trim().is_empty() {
        return None;
    }
    Some(parse_stack_text(&text, index))
}

/// Fallback parse of a stack item's text, shaped like `"0 - func at res://a.gd:24"`
/// or `"res://a.gd:24"`; best-effort, kept honest by also returning the raw text.
fn parse_stack_text(text: &str, index: usize) -> Value {
    let (file, line) = text
        .rsplit_once(':')
        .and_then(|(head, tail)| {
            let line: i64 = tail.trim().parse().ok()?;
            let file = head.rsplit([' ', '\t']).next().unwrap_or(head).to_string();
            Some((Some(file), Some(line)))
        })
        .unwrap_or((None, None));
    json!({ "index": index, "function": Value::Null, "file": file, "line": line, "raw": text })
}

/// Read the call stack from the dock. Returns `None` while the dock or its stack
/// tree has not yet populated (the caller keeps polling until its deadline).
pub(crate) fn read_stack(frame_limit: Option<usize>) -> Option<Result<Value, BridgeError>> {
    let dock = script_editor_debugger()?;
    let tree = stack_tree(&dock)?;
    let root = tree.get_root()?;
    let mut frames = Vec::new();
    let mut item = root.get_child(0);
    let mut index = 0usize;
    while let Some(current) = item {
        if let Some(frame) = stack_frame(&current, index) {
            frames.push(frame);
        }
        index += 1;
        item = current.get_next();
    }
    // The root item itself is sometimes the first frame rather than a container.
    if frames.is_empty()
        && let Some(frame) = stack_frame(&root, 0)
    {
        frames.push(frame);
    }
    if frames.is_empty() {
        return None;
    }
    if let Some(limit) = frame_limit {
        frames.truncate(limit);
    }
    Some(Ok(json!({ "frames": frames })))
}

/// The debugger dock's inspector, matched by its `EditorInspector` base class.
fn debugger_inspector(dock: &Gd<Node>) -> Option<Gd<EditorInspector>> {
    dock.find_children_ex("*")
        .type_("EditorInspector")
        .recursive(true)
        .owned(false)
        .done()
        .iter_shared()
        .next()
        .map(|node| node.cast())
}

/// Polls to wait after selecting a frame before reading the inspector, giving a
/// frame switch time to clear and repopulate so a read does not catch the prior
/// frame's variables.
const VARS_SETTLE_POLLS: u32 = 3;

/// Read local and member variables for a stack frame. Two-phase: the first poll
/// selects the frame's tree item, which triggers the engine's vars request to the
/// halted game; later polls settle once the inspector's edited object is present.
/// `None` keeps the caller polling.
///
/// Selecting the frame populates the dock inspector in about 100 ms even under a
/// virtual display (verified with the phase-5 probe). We settle on the first
/// non-null edited object after a short settle delay rather than on an
/// object-identity change, because the inspector shows nothing until a frame is
/// selected and reuses/keeps the object when the requested frame is already
/// shown; an identity-change gate would hang in that case (docs/api-gaps.md).
pub(crate) fn read_vars(frame: usize, selected: &mut bool, settle_countdown: &mut u32) -> Option<Result<Value, BridgeError>> {
    let dock = script_editor_debugger()?;
    let mut tree = stack_tree(&dock)?;
    let inspector = debugger_inspector(&dock)?;

    if !*selected {
        let root = tree.get_root()?;
        let target = nth_stack_item(&root, frame)?;
        tree.set_selected(&target, 0);
        // Some Godot builds populate vars on cell_selected rather than on the
        // programmatic set_selected; nudge it so both paths work.
        tree.emit_signal("cell_selected", &[]);
        *selected = true;
        *settle_countdown = VARS_SETTLE_POLLS;
        return None;
    }

    if *settle_countdown > 0 {
        *settle_countdown -= 1;
        return None;
    }

    let edited = inspector.get_edited_object()?;
    Some(Ok(read_object_vars(frame, &edited)))
}

fn nth_stack_item(root: &Gd<TreeItem>, n: usize) -> Option<Gd<TreeItem>> {
    let mut item = root.get_child(0);
    let mut index = 0usize;
    while let Some(current) = item {
        if index == n {
            return Some(current);
        }
        index += 1;
        item = current.get_next();
    }
    // Fall back to the root itself for a single-frame tree.
    if n == 0 {
        return Some(root.clone());
    }
    None
}

/// Group a remote object's properties into locals, members, and constants by the
/// category-prefix convention the debugger inspector uses.
fn read_object_vars(frame: usize, object: &Gd<Object>) -> Value {
    let mut locals = serde_json::Map::new();
    let mut members = serde_json::Map::new();
    let mut constants = serde_json::Map::new();

    for prop in object.get_property_list().iter_shared() {
        let name = prop.get(&GString::from("name")).map(|v| v.stringify().to_string()).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let (bucket, key): (&mut serde_json::Map<String, Value>, &str) =
            if let Some(rest) = name.strip_prefix("Locals/") {
                (&mut locals, rest)
            } else if let Some(rest) = name.strip_prefix("Members/") {
                (&mut members, rest)
            } else if let Some(rest) = name.strip_prefix("Constants/") {
                (&mut constants, rest)
            } else {
                continue;
            };
        let value = object.get(&StringName::from(name.as_str()));
        bucket.insert(key.to_string(), cap_value(variant_to_json(&value)));
    }

    json!({
        "frame": frame,
        "locals": Value::Object(locals),
        "members": Value::Object(members),
        "constants": Value::Object(constants),
    })
}

/// Bound a single value's serialised size, marking a clipped value explicitly.
fn cap_value(value: Value) -> Value {
    let encoded = value.to_string();
    if encoded.len() <= VAR_VALUE_MAX_BYTES {
        return value;
    }
    let mut clipped = encoded;
    clipped.truncate(VAR_VALUE_MAX_BYTES);
    json!({ "truncated": true, "preview": clipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breakpoint_list_dedupes_and_removes() {
        let mut list = BreakpointList::default();
        assert!(list.add("res://a.gd", 10));
        assert!(!list.add("res://a.gd", 10));
        assert!(list.add("res://a.gd", 20));
        assert!(list.add("res://b.gd", 5));
        assert_eq!(list.iter().count(), 3);

        assert!(list.remove("res://a.gd", 10));
        assert!(!list.remove("res://a.gd", 10));
        assert_eq!(list.iter().count(), 2);

        assert_eq!(list.remove_path("res://a.gd"), 1);
        assert_eq!(list.iter().count(), 1);
    }

    #[test]
    fn breakpoint_list_clear_reports_count_and_empties() {
        let mut list = BreakpointList::default();
        list.add("res://a.gd", 1);
        list.add("res://a.gd", 2);
        assert_eq!(list.clear(), 2);
        assert_eq!(list.iter().count(), 0);
        assert_eq!(list.clear(), 0);
    }

    #[test]
    fn breakpoint_list_json_shape() {
        let mut list = BreakpointList::default();
        list.add("res://player.gd", 24);
        let value = list.to_json();
        assert_eq!(value[0]["path"], "res://player.gd");
        assert_eq!(value[0]["line"], 24);
    }
}
