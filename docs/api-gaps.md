# API gaps and environment notes

Where the whitepaper's assumed API differs from the gdext/Godot version in use
(gdext 0.5.5, Godot 4.7.1), or where an environment constraint shaped the
implementation, it is recorded here rather than silently worked around (CLAUDE.md
"When stuck").

## Editor plugin does not instantiate in the game process

The whitepaper (sections 6.3, 13) assumes a single `EditorPlugin` runs in both
the editor and the launched game. In practice Godot only instantiates
`EditorPlugin`s in the editor; nothing creates the plugin in the game process.

Resolution: two node classes share one `BridgeCore`. `ConduitBridge`
(`EditorPlugin`) is the editor personality, auto-instantiated by the editor.
`ConduitRuntime` (`Node`) is the game personality, shipped as a one-node scene
(`addons/conduit/conduit_runtime.tscn`) and registered as a singleton autoload
(`[autoload] ConduitRuntime="*res://addons/conduit/conduit_runtime.tscn"`). This
adds one per-project line to `project.godot`, a small deviation from the
"zero per-project setup" goal, and is the only viable gdext mechanism to run
per-frame code in the game without a GDScript autoload.

## Variant construction requires an initialised engine

gdext `Variant` construction calls into the engine, so `variant_json`'s actual
conversions cannot run under plain `cargo test`. Only the pure tag-parsing and
field-extraction helpers are unit-tested; the conversions themselves are covered
by the live acceptance eval (property round-trips and `gd_game_eval`).

As of phase 8 the matrix and transform Variant types (`Basis`, `Transform2D`,
`Transform3D`, `AABB`, `Plane`, `Projection`) are tagged both directions,
completing the section 7.3 type table. The wire shapes use GDScript's property
convention (`x`/`y`/`z`/`w` are column vectors); gdext stores `Basis` by rows,
so the bridge maps through `from_cols`/`col_a..c`, pinned by an engine-free
unit test. Two gdext quirks: every `Plane` constructor asserts a unit normal,
so the bridge builds `Plane` via the documented non-panicking struct literal to
match GDScript's non-validating `Plane(a, b, c, d)`; matrix struct helpers are
engine-free (plain Rust structs) and unit-tested, while `Variant` round-trips
remain covered by the phase 8 eval. Remaining untagged types (`RID`,
`Callable`, `Signal`, `PackedVector4Array`) stringify on output.

## Typed collections in gdext 0.5.5

`Dictionary` and `Array` are generic in this gdext version; the untyped forms are
`VarDictionary` (`Dictionary<Variant, Variant>`) and `VarArray`
(`Array<Variant>`). `Object::get_property_list` and friends return
`Array<VarDictionary>`.

## Local socket path length (Unix)

Unix domain socket paths must fit `sun_path` (~108 bytes on Linux, ~104 on
macOS). The runtime directory holding the endpoints (`CONDUIT_RUNTIME_DIR`,
default the system temp dir) must therefore be short; a deeply nested directory
makes the bind fail with "local socket name length exceeds capacity of
sun_path". Linux `/tmp` is fine; on macOS the default temp dir (`/var/folders/.../T/`)
runs long, so the acceptance harness deliberately roots its runtime dir at `/tmp`.
This limit does not apply on Windows, whose transport is a named pipe.

## Cross-platform transport: Windows named pipes need a three-thread serve

The broker-to-bridge transport is per-platform: a Unix-domain filesystem socket
on Linux/macOS, a named pipe (`\\.\pipe\conduit-{role}-{hash}`) on Windows, both
via the `interprocess` crate, selected in `bridge/src/transport/ipc.rs`. Node/Bun
`net` on Windows cannot connect to an AF_UNIX filesystem socket (it maps IPC
paths to named pipes), so the Windows path must use `GenericNamespaced`, not
`GenericFilePath`.

The non-obvious constraint: `interprocess`'s `set_nonblocking(true)` on a Windows
named-pipe stream sets the legacy `PIPE_NOWAIT` mode, which Microsoft documents
as broken for duplex I/O. Empirically (a Bun<->interprocess round-trip on
Windows), non-blocking duplex fails immediately (`EPIPE`/`peer closed`) while
blocking duplex is reliable. The single-thread non-blocking serve loop that Unix
uses therefore cannot run over named pipes.

Resolution: the Windows serve path (`serve_split`, cfg-gated) uses blocking I/O
with `Stream::split()` over three threads -- a reader parked in a blocking read
feeding `inbound_tx`, a writer owning the send half because only one thread may
write the pipe, and the accept thread as supervisor, moving
`outbound_rx`/`event_rx` into the writer's queue, running the heartbeat, and
holding the write deadline the blocking calls cannot carry themselves (see the
liveness section). Backpressure `busy` responses are routed from the reader
through the same queue. This preserves the write-while-blocked-on-read property
that deferred `await` completions and debugger events require, validated by the
phase 1 stress acceptance on Windows. The proven Unix non-blocking loop is left
unchanged. An opt-in loopback TCP fallback (`CONDUIT_TCP`) exists for the editor
connection.

One shutdown caveat: a Windows reader or writer thread parked in a blocking pipe
call is detached, not joined, so joining it can never hang `Listener::stop()`; it
ends when the peer disconnects or the process exits. That last part is why
`serve_split` waits `WRITE_DRAIN_GRACE` (250 ms) for the writer's backlog on the
way out instead of returning immediately: closing the queue does not discard what
it holds, but a stop is usually followed by process teardown, which would take the
writer with it, and the frame at risk is the response to the command that ended
the session. The wait is bounded so a peer that is not reading cannot delay
shutdown. Phase 9 found a different stop hazard in this same function (a second
stop from Drop blocking in the wake connect) and made `stop()` idempotent; see the
phase 9 section.

One park is not reachable from this layer. When the write deadline fires, the
writer is inside a chunk write, so it never reaches its own final flush and drops
the send half with `needs_flush` set; `interprocess` then hands the handle to its
linger pool (`src/os/windows/linger_pool.rs`), which flushes it -- and
`FlushFileBuffers` on a pipe does not return until the peer has read everything.
That pool is process-wide: one persistent thread over a shared queue, with
overflow threads only once the queue is full, so a peer holding it there can delay
other lingered handles behind it. `evade_limbo`/`assume_flushed` exist only on the
concrete `PipeStream`, not on the `local_socket::SendHalf` enum we hold, so the
bridge cannot opt out. A peer whose process exits fails the flush immediately;
only a live peer that holds the pipe and never reads keeps it parked.

## Windows debug pack export cannot include the out-of-project bridge library

The example project's `.gdextension` references the built library outside the
project tree (`res://../target/{debug,release}/conduit.dll`) so the build output
need not be copied into the project. Observed: on Linux the *debug* preset pack
export (which includes the bridge) succeeds; on Windows it fails with
`Failed to open 'S:/.../example-project/../target/debug/~conduit.dll'` while
packing that native library. The root cause was not isolated -- candidates are
Godot 4.7.1's handling of an out-of-project (`res://../`) library path on Windows
and Windows' locking of the DLL while the exporting editor has it loaded; only
the failure was reproduced, not the mechanism. The *release* preset excludes the
bridge via `exclude_filter`, so it exports correctly on every platform and still
proves the whitepaper section 15 exclusion property. The phase 4 acceptance
records the debug-pack step as a known Windows limitation rather than failing.

## Rendering and screenshots need a real display

`godot --headless` forces the dummy renderer regardless of `DISPLAY`, so
`gd_screenshot` returns `not_available_headless` there (whitepaper section 13).
Capturing a genuine frame in CI requires a virtual display:

- run the editor and game under `xvfb-run` (not `--headless`);
- use the OpenGL compatibility renderer (`renderer/rendering_method="gl_compatibility"`
  plus `--rendering-driver opengl3`), because Vulkan does not initialise under
  Xvfb software rendering;
- install the X11 client and Mesa runtime libraries Godot dynamically loads
  (`libxcursor1`, `libxinerama1`, `libxi6`, `libxrandr2`, `libxrender1`,
  `libxext6`, `libxfixes3`, `libx11-6`, `libgl1`, `libglx-mesa0`,
  `libgl1-mesa-dri`, `libglu1-mesa`).

`scripts/setup.ts` installs this tooling on Linux. Audio drivers fail under this
environment and fall back to the dummy driver, which is harmless for the tools.

## Video capture of the editor is Linux-only

`scripts/demo/` records the README demo by grabbing the X display the editor
renders to (`ffmpeg -f x11grab`) on a virtual display the runner owns, which is
why `harness.ts` gained `startVirtualDisplay` alongside the existing `xvfb-run`
wrap: `xvfb-run -a` picks a display number the caller cannot predict, so nothing
outside the Godot process can attach to it. Windows and macOS render to a native
display and would need `gdigrab` and `avfoundation` respectively; neither is
wired up, and `bun run demo` refuses to run there rather than pretending.

The editor window is launched with `--position 0,0 --resolution 1600x900` and
lands there with no window manager running, so the grab needs no window
placement step. Under Godot 4.7 the launched game embeds inside the editor
window, so recording the editor also records the running game.

## make_bottom_panel_item_visible does not raise the Conduit panel under 4.7

`ConduitBridge::on_indicator_pressed` calls `EditorPlugin::make_bottom_panel_item_visible`
with the panel it registered via `add_control_to_bottom_panel`. Under Godot
4.7.1 the panel is reparented into an `EditorDock` wrapper
(`@EditorBottomPanel/@EditorDock/@ConduitPanel`) and the call does not bring the
tab forward; the bottom panel keeps whatever tab was selected. Pressing the
toolbar dot through `gd_editor_pixel_click` reaches the indicator and the signal
fires, so the gap is in the raise, not the input path.

The bottom panel's tab buttons are also not reachable from tier 2: a full
`gd_editor_ui op=find` walk of the editor base control (4655 controls) returns
nothing in the bottom tab strip, so there is no control to click as a
workaround. The demo therefore does not claim to open the panel on camera. The
editor's Output log still carries a line per undo-wrapped action
(`Conduit: Add ColorRect`, `Conduit: Attach res://coin.gd to Coin1`), which is
visible in the recording without any UI driving.

## gd_signal await

Phase 17 replaced the implementation. The note is kept rather than deleted
because the response still carries the keys the old shape defined, and because
what it said about them was not quite right.

`await` used to delegate to the evaluation runner with a generated
`return await Signal(get_node(path), signal)` snippet. It is now a native
connection: a `Callable::from_fn` writes the emitted arguments into a cell and a
`PendingOp` settles on the next frame (`bridge/src/handlers/signals.rs`).

The response gained `args`, the unambiguous full argument list, and kept `value`
and `type`. `value` reproduces what GDScript `await` yields rather than the
first argument: nothing for a zero-argument signal, the argument itself for one,
and an **array** for more than one. The earlier note here said "yields its first
argument", which was wrong past arity one and would have made the new response
diverge silently from the old for exactly the signals where it matters. The
phase 17 runner asserts the arity-two case (`Input.joy_connection_changed`)
against both keys.

The wait is still bounded by the broker's per-request timeout, with a frame
deadline behind it so a signal that never fires cannot grow the pending set.
Connect, disconnect, emit, and list are direct synchronous calls, as they always
were.

## Phase 3: editor bridge

`EditorUndoRedoManager` exposes no `undo()`/`redo()`. Reach them via
`get_history_undo_redo(get_object_history_id(object)).undo()`/`.redo()` on the
returned `UndoRedo`.

`add_do_method`/`add_undo_method` are panicking varcalls (they
`unwrap_or_else(|e| panic!(...))` internally on failure). Use
`try_add_do_method`/`try_add_undo_method`, and prefer `add_do_property`/
`add_undo_property` (infallible) for plain property changes.

`ClassDb::instantiate` returns `Variant`, not `Gd<T>`; every caller must
`.try_to::<Gd<T>>()` and handle cast failure as a `ResourceError`.

`EditorFileSystem::reimport_files` is documented as blocking, pumping the main
loop internally while it runs; calling it risks re-entering the dispatcher
while our own borrow is on the stack. Use non-blocking `scan()`/
`scan_sources()` plus polling `is_scanning()` instead.

An earlier form of this note claimed `Object` has no public
`set_script`/`get_script`; that is stale. gdext 0.5.5 provides both as
type-safe replacements (`get_script() -> Option<Gd<Script>>`), and phase 9's
project-tools discovery uses them. The undo-wrapped `script` property writes
here still go through the generic dynamic property API because undo recording
needs a property, not a setter call.

UID dependent-reference reporting on `gd_file_move` is not implemented: no
reverse-dependency query was found at the `EditorFileSystem`/`EditorInterface`
level short of walking `EditorFileSystemDirectory` in more depth than this
phase justifies. `gd_file_move` returns an empty `dependents` array with an
explanatory note rather than silently claiming nothing references the old
path.

`debug/file_logging/enable_file_logging` is not honoured for `--editor`
sessions in Godot 4.7.1, regardless of the project setting's value; only
game/export runs write `user://logs/godot.log` on their own. The reliable
mechanism for editor-mode log capture is the `--log-file <path>` launch
argument, which `log_tail::log_file_path()` prefers over the project setting
when present.

`gd_script_validate` originally reloaded the script in the live editor
process and tailed its own `--log-file` output. Reads from within that same
process's own handler did not observe the just-emitted diagnostic lines
within several real seconds of waiting (confirmed both via accumulated
dispatcher frame count and via a genuine `std::time::Instant` deadline),
even though a separate process (a debug harness) reading the same file
shortly afterward, while the editor was still running, did see them. The
exact mechanism behind that gap was not pinned down (it is not simply
"unflushed until N KB of output accumulates": the run in question wrote only
a few hundred bytes) and is not worth chasing further, since a live editor
process is not a reliable diagnostics source either way for a tool that needs
a bounded answer. The fix: `gd_script_validate` now parses the target script
in a fresh, short-lived subprocess (`godot --headless --path <project>
--script <path> --check-only`) and reads its captured stdout/stderr only
after `try_wait` reports the process has exited — a point at which the
subprocess's own output is guaranteed complete by the OS, independent of any
flush timing question. The subprocess has
`CONDUIT_ENABLE`/`CONDUIT_SOCK`/`CONDUIT_RUNTIME_DIR` stripped from its
environment so its own GDExtension init never attempts to bind a bridge
socket. The tradeoff is a full Godot startup per validation call (roughly
0.3s for a trivial script, more for a larger project) rather than an
in-process reload.

That subprocess's exit status turned out not to be portable. `--check-only`
exits non-zero on a parse error on Linux and Windows but exits **0** on macOS,
and `gd_script_validate` decided the verdict from the status alone, so a script
with a syntax error came back `valid: true` with no diagnostics. The phase 3
acceptance check `script_validate_reports_broken_script` caught it the first
time the acceptance suite ran on macOS, which is the whole reason that job is a
three-platform matrix; on Linux alone it had looked correct for every release so
far.

The verdict now needs both signals: the subprocess must have exited clean *and*
its output must not name a parse failure. The output test
(`output_reports_script_error`) is deliberately narrower than
`extract_diagnostics`, which counts any line containing "error" — right for
listing what went wrong, wrong as a validity test, since one unrelated engine
warning would then fail every valid script. The response also carries
`exit_code` now, so a future divergence is visible without a CI round-trip.

`EditorInterface::get_open_scenes()`/`get_scene_file_path()` do not reliably
reflect a just-opened scene immediately after `open_scene_from_path` under
headless `--editor` runs (both were tried as the readiness signal for
`gd_scene_open` and neither became true within a generous polling budget).
`get_edited_scene_root().is_ok()` — the same call `gd_scene_tree_get` itself
makes — is ready immediately in practice and is what `gd_scene_open` now polls
for. Known limitation: this only proves *a* scene is edited, not that it is
specifically the requested `path` — opening a second scene while a first is
already open could report ready before the second scene has actually loaded.
Not exercised by any current tool (each session opens one scene into a fresh
headless editor); worth revisiting if `gd_scene_open` needs to support
switching between already-open scenes.

## Phase 4: headless export

No gdext binding for the export subsystem exists in this version
(`EditorExportPlatform`/`EditorExportPreset` are absent from the crate's
generated API, and the whitepaper's own Appendix B has no entry for it
either). `gd_export_project` is implemented as a subprocess shell-out to
Godot's own headless export CLI (`--export-pack` / `--export-debug` /
`--export-release`), following the exact precedent `gd_script_validate`
already established (`script.rs`): find the running Godot binary via
`Os::get_executable_path()`, spawn it fresh and short-lived with
`CONDUIT_ENABLE`/`CONDUIT_SOCK`/`CONDUIT_RUNTIME_DIR` stripped from its
environment, and read its captured output back only once `try_wait` confirms
the process has exited. This is not a fallback of last resort: Godot's export
CLI flags are themselves the documented, stable, CI-standard mechanism for
headless exports.

One consequence worth noting: an export CLI invocation reports
`is_editor_hint() == true` even without `--editor` (confirmed empirically —
the bridge's own "Conduit (editor): listening on ..." log line appears during
a bare `--export-pack` run). Unlike `gd_script_validate`'s subprocess (which
runs non-editor, so removing `CONDUIT_ENABLE` genuinely stops its bind), the
export subprocess's editor personality binds *unconditionally* —
`should_bind()` returns `true` for `is_editor` regardless of the opt-in env
vars, so stripping them cannot prevent the bind, only relocate it to the
default socket path (`CONDUIT_RUNTIME_DIR` + a hash of the project path).
That default is exactly what a live editor launched *without* an explicit
`CONDUIT_SOCK` also computes — confirmed empirically that an export
subprocess with `CONDUIT_RUNTIME_DIR` merely removed unlinks and steals a
live editor's default socket file out from under it, breaking the broker's
connection to a running session. The fix is isolation, not prevention: the
handler sets `CONDUIT_RUNTIME_DIR` (rather than removing it) to a fresh,
private, throwaway directory per export call, so whatever the subprocess
inevitably binds can never collide with the parent's socket. Confirmed fixed
empirically the same way the bug was found: a live editor bound to its
default socket path stays connectable across an export call once this
isolation is in place.

Export templates are not required for `--export-pack` (confirmed empirically
against Godot 4.7.1 with an empty `~/.local/share/godot/export_templates/`):
pack-only mode writes only a resource-data file, never the platform template
binary, and needs no virtual display either (export is asset packing, not
rendering). `--export-debug`/`--export-release` do need a matching-version
template and were not exercised by the phase 4 acceptance eval for that
reason; `scripts/setup.ts` was deliberately left without template-download
logic, since the low-cost `--export-pack` path was sufficient to satisfy the
phase's acceptance criterion. Add that download step if a future phase needs
a runnable (non-pack) headless export.

The Godot 4.7.1 Linux export platform's preset name is `"Linux"` (the
pre-4.3 `"Linux/X11"` naming is gone). Godot does not create missing
intermediate directories for the export output path — a first write to
`res://export/...` fails with "Can't open file for writing" unless the
handler creates the parent directory itself first, which
`import_export.rs` does.

`example-project/export_presets.cfg`'s bridge files are split across two
locations that don't match the whitepaper section 11/15 packaging layout: the
`.gdextension` manifest lives at the project root
(`example-project/conduit.gdextension`, the current dev layout), while only
the runtime scene lives under `addons/conduit/`. A release preset's
`exclude_filter` must therefore list both `addons/conduit/*` and
`conduit.gdextension` (plus its `.uid` sidecar) to fully exclude the bridge —
excluding only `addons/conduit/*`, as the whitepaper's packaging description
alone would suggest, leaves `conduit.gdextension` behind.

## Phase 5: debugger and editor collaboration

### The debugger plugin's capture only sees prefixed messages

`EditorDebuggerPlugin::capture(message, data, session_id)` is only invoked for
messages whose name is prefixed with the plugin's registered capture namespace.
The core debugger replies `stack_dump` and `stack_frame_vars` carry no such
prefix, so they never reach the plugin. Execution control (`break`, `continue`,
`next`, `step`) works fine through `EditorDebuggerSession::send_message`, and
the break/continue lifecycle is observable through the session's `breaked` and
`continued` signals, but stack and variable data are not.

Resolution: `gd_debug`'s `stack` and `vars` ops read the editor's own debugger
dock, the tier-2 fallback whitepaper section 6.9 sanctions. The message names
sent for control (`break`, `continue`, `next`, `step`) are the Godot 4.7.1 core
protocol names and were verified working against that build.

### Debugger-dock structure (Godot 4.7.1)

The dock read in `debugger.rs` targets this live structure, discovered by
walking the tree at a break (a future Godot may move these; the reads are
class-based scans with text/metadata fallbacks so they degrade to a clear
`call_failed` rather than misbehaving):

- The dock is a `ScriptEditorDebugger` (one per session, named `Session N`),
  reachable from `EditorInterface::get_base_control()` via `find_children` typed
  `ScriptEditorDebugger`.
- The call stack is a `Tree` whose root children are the frames. Each frame item
  carries a column-0 metadata `Dictionary` with `file`, `line`, and `frame`; its
  text is shaped `"0 - res://player.gd:24 - at function: _process"`. The stack is
  populated automatically on break (no request needed), so `stack` settles in one
  poll.
- Frame variables live in an `EditorDebuggerInspector` (a subclass of
  `EditorInspector`; there are two under the dock, and the first in tree order is
  the stack-vars one, the second belongs to the expression evaluator). It shows
  nothing until a stack frame is selected. Selecting the frame's tree item and
  emitting `cell_selected` triggers the engine's `get_stack_frame_vars` request;
  the inspector populates about 100 ms later with an `EditorDebuggerRemoteObjects`
  whose property names are prefixed `Locals/`, `Members/`, and `Constants/`.

`vars` settles on the first non-null edited object after a short settle delay,
not on an object-identity change: the inspector reuses/keeps the object when the
requested frame is already shown, so an identity-change gate would hang. A
consequence is that switching to a *different* frame while a previous frame's
vars are still shown can, in a narrow window, read the prior frame; the settle
delay makes this unlikely and the common frame-0 case is exact.

### The editor throttles hard while a game is halted

While a game is breaked, the editor drops to its unfocused idle tick rate (a long
per-frame sleep), which under a virtual display starved the pending-op polling
that reads the dock and made a `vars` read take tens of seconds. `EditorNode`
re-applies the unfocused throttle on window-focus churn, so a one-time
`OS::set_low_processor_usage_mode(false)` does not stick.

Resolution: `ConduitBridge::process` calls `debugger::keep_editor_responsive`
every frame while a session is breaked, re-asserting
`set_low_processor_usage_mode(false)` and a small sleep, and restores the prior
value on continue/stop. With this, stack settles in one poll and vars in well
under a second.

### game_breaked is a broker-side state, not per-instance

While a game is halted its main loop does not run, so its bridge never drains and
game-bridge tools cannot complete. The broker learns the break state from the
editor bridge's `debug_breaked`/`debug_continued` event frames (the first
unsolicited bridge-to-broker events; see `protocol::Event`) and short-circuits
`gameRequest` with a distinct, retryable `game_breaked` error instead of letting
the call time out. This is one global flag, not mapped per game pid: debug
sessions are editor-session-scoped (`session_id`), not tied to a specific game
instance, so a multi-instance debug session is not distinguished. Adequate for a
single debugged game; per-pid mapping is deferred.

### Triggering the save-confirmation dialog

The phase-5 acceptance dismisses a confirmation dialog. It is produced by
activating the editor's Scene > Close Scene menu entry on a dirtied scene. The
menu is a `PopupMenu` under the main-window `MenuBar` (`Scene`); `gd_editor_ui`
`select_item` emits its `id_pressed` directly, which runs the menu action
without showing the popup, and Close Scene on a dirty scene raises a
`ConfirmationDialog` ("Please Confirm...", buttons Don't Save / Cancel /
Save & Close). The node names in the menu path carry unstable `@Class@NNNN`
suffixes, so tools and the eval locate the menu by finding `PopupMenu`s and
matching the item text rather than by a fixed path.

### Editor pixel input reaches the canvas via push_input; scene tabs do not switch under headless --editor

The phase-6 tier-3 tools (`gd_editor_pixel_move`/`click`/`drag`) synthesise input
through `Viewport::push_input` on the editor base-control viewport, as the
whitepaper (section 6.8) prefers. This was verified to drive both editor chrome
and the 2D `CanvasItemEditorViewport`: a synthesised click at a node's screen
position selects it, so no `Input::parse_input_event` fallback was needed.

A separate observed limitation surfaced while building the phase-6 acceptance:
under a headless (`--editor` on Xvfb) run, `EditorInterface::open_scene_from_path`
(`gd_scene_open`) opens a scene in a background tab but does not reliably make it
the active edited scene, so `get_edited_scene_root` keeps returning the
previously current scene. This is the same tab-bar-under-headless weakness noted
for `get_open_scenes` in `scene.rs`. The workaround, where a specific scene must
be the current one under headless, is to pass the scene path as a startup
argument to the editor (`godot --editor --path <proj> res://scene.tscn`) rather
than switching after launch; the phase-6 eval does this.

## Phase 7: edit-time parity core

### The eval driver script must be @tool for the editor process

`gd_editor_eval` reuses the runtime eval machinery (`runtime/eval.rs::run_source`):
the editor's MainLoop is a `SceneTree`, and the `PendingOp` deferred-completion
path runs in the editor's dispatcher identically. The one required change was
prepending `@tool` to the generated driver script; without it the script does
not instantiate in the editor process (`set_script` produces no instance and
`has_method("_conduit_run")` fails). `@tool` is inert in a running game, and the
phase-2 eval passes unchanged with it, so the same wrapper serves both bridges.
Verified live: an awaiting snippet (`await ...process_frame`) settles in the
editor process through the same deferred-completion path.

### The editor's live InputMap is deliberately not reloaded

`gd_input_map` mutates `input/{action}` project settings and saves. It does not
call `InputMap.load_from_project_settings()` in the editor process: the editor's
live InputMap holds editor bindings, and reloading project actions into it would
clobber them. Games load the map at startup, so persistence is the correct
semantics; the tool description says so. The same applies to `gd_autoload`: the
running editor does not instantiate a newly added singleton, and the tool
documents that it takes effect in subsequently launched games.

### ProjectSettings enumerates autoload/* and input/* including overridden built-ins

`ProjectSettings::get_property_list()` includes `autoload/{name}` entries and
`input/{action}` entries for project-defined values (verified live against
4.7.1). Built-in `ui_*` actions that the project has not overridden do not
appear there, so `gd_input_map list` reports project-defined and overridden
actions only.

### gd_classdb routing

The `gd_classdb` handler is registered in both bridge personalities, but the
broker registers the single MCP tool routed to its editor connection, which is
always present (the broker refuses to start without it) and holds identical
reflection data. A future game-only broker mode would re-route it to the game
bridge. The game-side registration is exercised by the phase-7 eval over the
raw bridge protocol.

### The named-pipe listener serves one broker at a time (Windows)

A consequence of the two-thread blocking serve (see the transport note above):
while one broker holds the editor pipe, a second broker's connect is refused.
The phase-7 eval therefore closes its default broker before connecting the
`--enable-editor-eval` broker. The listener accepts a new connection as soon as
the previous client disconnects, matching the reconnect guarantee of whitepaper
section 7.5.

### The project-path hash must be resolved, not just absolutised (macOS)

Both ends derive the endpoint from a hash of the project path, and they have to
agree without coordinating. The bridge's side comes from
`globalize_path("res://")`, which Godot returns with every symlink resolved. The
broker used `path.resolve`, which makes a path absolute but follows no symlinks.

On Linux and Windows those agree in practice. On macOS `/var` and `/tmp` are
symlinks into `/private`, so a project anywhere under either — a scaffold in
`os.tmpdir()`, which is `/var/folders/.../T`, is the ordinary case — hashed
differently on the two sides:

```
conduit-broker: connecting to editor bridge at .../conduit-editor-887d412f.sock
Conduit (editor): listening on            .../conduit-editor-9b4033b7.sock
```

The editor was healthy and its extension had loaded; the broker was simply
waiting on a name nothing would ever bind. `gd_editor_launch` timed out after
45s with no other symptom. The phase 9 acceptance caught it the first time that
suite ran on macOS.

The broker now resolves the real path (`realProjectPath` in `broker/src/index.ts`),
falling back to the deepest existing ancestor plus the remainder when the
directory does not exist yet, which `gd_project_scaffold` relies on.
`canonicalProjectKey` is deliberately not where this belongs: it is a pure string
function mirrored in Rust, and the Rust side was already right.

### One broker at a time is not a Windows property, and it fails differently on Unix

The constraint above is general. Every accept loop in `bridge/src/transport/ipc.rs`
runs `accept()` and then serves that one connection to completion before
accepting again: `accept_loop_local` for Unix sockets, `accept_loop_tcp`, and
`accept_loop_pipe`. Only the symptom differs. A Windows pipe refuses the second
connect outright, which is a fast, legible error. A Unix socket and a TCP
listener both take the second connection into the backlog and then never write
to it, so the second broker sits in `waitForHello` for its full five-second
timeout and sees a bare timeout with no indication of the cause.

Two consequences shaped the broker. `attemptEditorConnect` maps
connected-then-silent onto its own `editor_busy` code, because that shape means
"someone else is being served" and nothing else. And `startEditorReconnect`
backs off geometrically on `editor_busy` only, not on an ordinary refusal: each
attempt against a held bridge occupies the accept slot for five seconds, which is
the same slot the incumbent broker needs to reconnect through, so retrying hard
actively harms the connection that works.

This is also why the editor connection must not sit on the MCP startup path. It
did through 0.6.0: `main()` awaited `connectEditor()` before creating the stdio
transport, so a broker started against a project that already had one left stdin
unread for the call's ten-second deadline and the client reported a server
timeout. `bun run handshake` (`tests/evals/startup_handshake.ts`) pins the fix,
including against a listener that accepts and stays silent.

### A closed socket is not the only way a peer dies

Both ends used to treat the socket closing as the sole disconnect signal. That
covers a crash: a process dying takes its descriptors with it whatever killed it,
so EOF arrives whether the exit was clean, a SIGKILL, a segfault, or an OOM kill.
It does not cover a peer that is still holding the descriptor while being unable
to act on it, and there are four such cases.

- **An orphaned broker.** The MCP SDK's `StdioServerTransport` listens for `data`
  and `error` on stdin but never for its end, so the client closing stdin fires
  nothing, and the connected bridge socket is a live handle that keeps the process
  running. The broker now watches stdin itself and handles `SIGTERM`/`SIGINT`,
  releasing its bridge connections before exiting.
- **A suspended or wedged peer.** `SIGSTOP`, a debugger, a sleeping laptop. No FIN
  is ever sent.
- **An inherited descriptor.** `gd_editor_launch` spawns an engine from the
  broker; any descriptor reaching that child outlives the broker.
- **A peer that stops reading.** This one hung the bridge outright.
  `write_framed_bytes` retried `WouldBlock` in a sleep loop whose only exit was
  the stop flag, so a full socket buffer pinned the IO thread inside a single
  frame, the serve function never returned, and `mark_listening` was never
  reached. It now has a deadline.

The heartbeat of whitepaper section 7.5 covers all four uniformly, in both
directions, because it does not care why the peer went quiet. Two properties of
its design are worth stating because they are easy to get wrong:

Liveness frames are handled on the IO path at both ends, never through the
dispatcher. A pong therefore attests to the transport and says nothing about the
engine's main thread, which is deliberate: an export runs on a ten-minute budget
and must not read as death. Per-request timeouts remain the check on main-thread
responsiveness, and `game_breaked` still covers the debugger case.

The deadline arms only once a peer has answered a ping. `PROTOCOL_VERSION` stays
1, so a broker and bridge from adjacent releases still interoperate; without the
arming rule, a new bridge would disconnect an older broker every twenty seconds
for not speaking a frame that did not exist when it was built. An unanswering
peer degrades to close-only detection, which is exactly what it had before.

Covered by `liveness` in `bridge/src/transport/ipc.rs`, `BridgeClient liveness`
in `broker/tests/ipc-client.test.ts`, and the orphan case in `bun run handshake`.
The Rust and TypeScript timings are scaled down under test so the assertions cost
milliseconds rather than a half-minute each.

Windows needed a second mechanism for the fourth case, because `serve_split`
writes with blocking calls and a blocking call cannot carry the deadline
`write_framed_bytes` has. It was worse than "a peer that stops reading while
frames are queued": every write went through `protocol::write_frame`, which ends
in `flush()`, and `flush` on a pipe send half is `FlushFileBuffers`, documented as
not returning until the peer has consumed everything buffered. One small response
was therefore enough to park the writer -- and the writer was the accept thread,
so `serve_split` never returned and the accept slot was never freed. The hello
frame did it before the link was even marked connected. The 512-byte default
`output_buffer_size_hint` on the listener's instances meant the write itself
blocked early too.

The deadline is now enforced from outside the write. The send half belongs to a
`conduit-ipc-write` thread that writes in 64 KiB chunks and reports each one;
the accept thread only queues frames and watches, and abandons the connection
after `WRITE_STALL_TIMEOUT` with outstanding work and no progress. Four
properties that are easy to lose:

- The stall check runs on every pass, not from the idle branch. A peer that stops
  reading while the dispatcher keeps producing has something to queue every time
  round and never goes idle, which is the original failure.
- Only a chunk written, or work arriving on an idle writer, counts as progress.
  Stamping every enqueue looks equivalent and defeats the whole deadline: the
  heartbeat queues a ping every `PING_AFTER`, which is well inside the deadline, so
  the clock would restart forever on a writer that has moved nothing. Observed as
  the new test hanging for its full 90-second settle.
- Nothing flushes between frames. A flush is a park with no progress to report,
  which would make a merely slow peer look stalled; the bytes reach the peer from
  `WriteFile` alone. One flush runs after the last frame, on the writer thread.
- The chunk size is the progress granularity, so it sets how slowly a live peer
  may drain before being mistaken for a stalled one: one chunk per deadline, about
  3 KiB/s. It is not what bounds the stall -- the supervisor is.

Covered by `a_peer_that_stops_reading_is_dropped_and_the_listener_serves_the_next_one`
in `bridge/tests/transport_liveness.rs`, over the real pipe with the shipped
constants. It answers no ping, so the liveness deadline stays unarmed and the
write-stall deadline is the only thing that can free the listener.

### gd_play from a headless editor remains unproven

Phase 7's game-side checks (`gd_find_nodes`, `gd_classdb` on the game bridge)
use the phase-4 pattern: a bare `godot --headless` game with the `CONDUIT_ENABLE`
opt-in, driven over the raw bridge protocol. `gd_play` from a `--headless`
editor spawns a child that expects a display, and the broker only adopts game
bridges it launched through `gd_play`, so the split acceptance avoids both.

## Phase 8: runtime systems parity

All verified live against Godot 4.7.1 headless by `bun run phase8`, which runs
entirely as a bare headless game over the raw bridge protocol (the phase 4/7
part-B pattern) launched straight into `res://phase8.tscn`, and captures the
game's stderr to a log so a failed dynamic call is diagnosable.

### Navigation classes are gated behind gdext's experimental API feature

gdext 0.5.5 generates no bindings for `NavigationServer2D/3D` or
`NavigationRegion2D/3D` unless the `experimental-godot-api` feature is enabled
(Godot marks the navigation classes experimental). Per the working instructions,
`gd_physics` reaches them dynamically instead of flipping the feature:
`Engine.get_singleton("NavigationServer2D")` plus `call("map_get_path", ...)`
for paths, and `node.call("bake_navigation_polygon"/"bake_navigation_mesh")`
for baking, each guarded by `has_method`/singleton presence checks. Verified
live: an unbaked map returns an empty path without error, and a synchronous
bake followed by a map sync (about 10 frames) produces a real path.

### The world's default gravity answers on the space RID

`PhysicsServer2D/3D.area_set_param` and `area_get_param` accept the space RID
(`World2D/3D.get_space()`) as the default world area, the documented
runtime-change path for gravity. Verified live: the 2D default reads 980 and a
write reads back. `gd_physics world_set` uses it for `GRAVITY` and
`GRAVITY_VECTOR`; the physics tick goes through
`Engine.physics_ticks_per_second`.

### Space queries run between physics steps

Direct-space-state queries from the `_process` drain are safe under the default
single-threaded physics (the space is not mid-step). With
`physics/2d/run_on_separate_thread` enabled the engine may reject them as
space-locked; the handler surfaces that as `call_failed` rather than guarding
against a configuration the example project does not use.

### Simulated joypad events drive actions, not Input.get_joy_axis

`Input.parse_input_event` with `InputEventJoypadMotion` feeds the action system
(`Input.get_action_strength` reflects the held axis across frames, verified
live through the `phase8_axis` fixture action bound to axis 0 with device -1)
but does not update the OS-layer joypad state behind `Input.get_joy_axis`,
which reflects only real devices. The `gd_input` description says so. Held-axis
semantics: a nonzero value holds the bound action's strength until a `value:
0.0` event releases it, the axis analogue of press-without-release.

### Plane construction must bypass the gdext constructors

Every gdext `Plane` constructor (`new`, `from_components`, ...) asserts a unit
normal and panics otherwise. Agent input goes through the documented
non-panicking struct literal `Plane { normal, d }`, matching GDScript's
non-validating `Plane(a, b, c, d)`.

### Headless DisplayServer accepts window setters as no-ops

Under `--headless` the window `set_size`/`set_position`/`set_mode` calls are
accepted and some report back (the title round-trips; the size stays the dummy
64x64), so `gd_window set` echoes `get_info` after writing and the agent sees
what actually stuck. `get_info` reports `display_server: "headless"` and a
`headless` flag so agents can branch.

### Layout: runtime/system.rs is an intentional addition

Whitepaper section 11 lists no file for the window/system group; single-file-
per-concern puts it in `bridge/src/handlers/runtime/system.rs` rather than
overloading `systems2d3d.rs` (which is the TileMap/GridMap cells file).

### Capabilities covered by existing generic tools, not new ops

Full-parity closure for these relies on tools that already exist, now that the
matrix and transform types convert: lights and camera attributes (node and
resource properties via `gd_node_set_property`/`gd_render`), spatial audio
configuration (positional player properties), physics body and joint
configuration (`gd_node_set_property` plus `gd_tree_mutate add_node` for
creating shape, joint, and light nodes), skeleton IK (SkeletonIK3D or
SkeletonModifier3D via `gd_node_call`), and richer physics query shapes
(`gd_game_eval`). CSG, multimesh, procedural meshes, canvas layers, parallax,
and curves are outside phase 8's enumerated scope (section 10 claims only
"TileMap and GridMap cells" from the 2D/3D systems group) and remain reachable
through `gd_game_eval` and the generic tools.

### Deprecated TileMap is rejected

`gd_tilemap` accepts `TileMapLayer` (the 4.3+ node) and `GridMap` only; the
deprecated `TileMap` node gets an `invalid_args` error naming `TileMapLayer`.
GridMap cell storage works with a MeshLibrary present (the fixture builds a
one-item library in `_ready`); bare-GridMap storage without a library was not
exercised.

### AnimationTree state machines answer through parameters/playback

`gd_animation tree` reaches the state machine playback object dynamically:
`tree.get("parameters/playback")` yields the `AnimationNodeStateMachinePlayback`
object, and `travel`/`start`/`stop`/`get_current_node`/`is_playing` go through
dynamic `call` (the playback class is a non-node Object with no direct-typed
path worth adding). Verified live: travel on an activated tree reaches the
target state within a few frames. The fixture keeps the tree inactive until
the check so it does not take over the AnimationPlayer during the player
checks.

### Gestures inject and deliver headless

`InputEventMagnifyGesture` and `InputEventPanGesture` constructed by `gd_input`
and fed through `parse_input_event` reach `_input` handlers in a headless game
(verified live via the fixture's gesture capture). Debug draw is state-only
headless: the ops track and expire primitives (verified), but pixels are
rendering-exempt per the acceptance carve-out.

## Phase 9: project-defined tools and session lifecycle

All verified live against Godot 4.7.1 headless by `bun run phase9`: part A
scaffolds an empty temp directory and drives a broker started with no editor
at all; parts B through D run against the example project with bare headless
games adopted by the broker's background discovery.

### An idempotent listener stop, or a clean editor exit hangs

`Listener::stop()` used to run its full body twice: once from the explicit
`BridgeCore::stop()` and again from the `Drop` impl on the same object. The
second `wake_accept` connects to the pipe name after the accept thread is
gone; with a broker client still holding the old instance open, Windows
`WaitNamedPipe` blocks forever and editor shutdown never finishes. This made
`SceneTree.quit()` look ignored by the editor (the main loop had exited; the
process just could not die). `stop()` now takes the join handle first and
returns immediately when it is already gone. With that fixed,
`SceneTree.quit()` cleanly terminates a headless editor (exit code 0), so
`gd_editor_quit` uses it directly: unlike the window-manager close request it
never raises a save-confirmation dialog, matching the tool contract that
unsaved editor state is discarded. The quit itself is deferred behind a
frame-count plus wall-clock schedule so the response frame flushes first, and
a grace-period self-kill (`OS.kill(OS.get_process_id())`) backstops a stalled
shutdown.

### Export presets list through ConfigFile

gdext exposes `EditorExportPreset` as a class but no scriptable entry point
enumerates the configured presets (no `EditorExport` singleton is bound).
`gd_export_presets` reads `res://export_presets.cfg` through `ConfigFile`,
Godot's own serialisation of its own file. Sections are filtered to exactly
`preset.<digits>` so the sibling `preset.N.options` tables never list; a
missing file is an empty list, not an error.

### The scaffold copies the bridge library into addons/conduit

`gd_project_scaffold` copies the built library next to its generated
`.gdextension` instead of pointing at the cargo target directory the way the
example project's root manifest does. A temp-directory scaffold on Windows
can sit on a different drive than the repo, where no `res://../` relative
path exists at all, and the copy matches the section 15 addon layout. The
manifest writes only the host platform's keys (debug and release both mapped
to the one copied file) because a wrong key fails silently: the extension
just never loads and `gd_ping` times out with nothing in the log. Verified
live: broker and bridge derive the same endpoint hash from the absolute temp
path (`canonical_project_key` agreement), and a cold project's first headless
open binds the bridge in five to ten seconds, well inside the sixty-second
launch window.

### Game discovery is single-owner

The broker's background discovery loop is the only code that connects to
newly advertised game endpoints; `waitForGame` funnels through the same
guarded scan instead of racing its own clients onto the pipe (fatal under
the Windows one-client-per-pipe constraint). This is also what adopts games
launched externally with the opt-in flag (section 7.5): the phase 9 eval
never calls `gd_play`.

### Project tool signatures come from get_script_method_list

Instance `get_method_list` includes every inherited engine method;
`node.get_script().get_script_method_list()` yields script-declared methods
only, in the same dictionary shape ClassDB uses, so the classdb parsing
helpers are shared. The `args` entry arrives as a typed `Array[Dictionary]`,
which gdext's strict conversions reject as `VarArray`; both shapes are
accepted (the same both-shapes guard `classdb::args_json` needed). Untyped
GDScript parameters report type NIL and surface as `Variant` (`z.any()` at
the broker); a coroutine (awaiting) project method returns its function-state
object, not the awaited value, so projects needing awaited results wrap them
in `gd_game_eval`.

### WebSocketPeer and HTTPRequest ride existing machinery

`WebSocketPeer` makes no progress unless polled, so the game bridge's
`_process` services every open connection each frame and drains packets into
bounded drop-oldest inboxes. `HTTPRequest` completes through its
`request_completed` signal into a native sink polled by a `PendingOp`,
exactly the `gd_game_eval` deferred-completion pattern. ENet goes through
the tree's MultiplayerAPI, which the SceneTree polls itself; the eval's
cross-instance server/client leg is deliberately non-fatal in the runner
because networking is outside the phase 9 acceptance criterion.

### Failed pipe connects escape bun test on Windows

Under `bun test` (1.3.x) on Windows, a failed named-pipe connect fails the
running test as an uncaught error even with an `error` handler attached and
the promise rejection awaited in a try/catch; the standalone runtime handles
the same code correctly (every eval proves it). The bridge-manager unit test
for `ensureEditorConnected` therefore probes a refused loopback TCP connect,
which is delivered normally on every platform.

## Addon auto-install and engine discovery

Post-v0.3.1 work, outside the nine numbered phases: the broker installs the
addon into a project that lacks one, and resolves the Godot binary itself.

### Endpoint enumeration cannot identify the project behind an endpoint

`short_hash` is one-way, so a discovered `conduit-editor-<hash>` cannot be
mapped back to a project path without connecting and reading the hello frame.
Connecting is not free: on Windows a bridge pipe serves one client at a time
(see the named-pipe section above), so probing an editor another broker owns
would break that broker's connection. `listEditorTokens` therefore exists only
to *count* what is advertised, and `BridgeManager.editorHint` turns that count
into the three cases a user actually hits: our endpoint present but not
accepting (starting up, or already held), nothing advertised at all (no editor,
or no addon installed), and endpoints present but none ours (the wrong
`--project`). Nothing connects to what the scan returns.

### CONDUIT_TCP has nothing to enumerate

Under the loopback TCP fallback the endpoint is a hash-derived port with no
filesystem or namespace presence, so `listTokens` returns empty. An empty result
there means "cannot tell", not "none running", and the hint says so rather than
reporting a false negative. Game discovery has the same blind spot: under
`CONDUIT_TCP` the broker cannot find a game it did not launch, because there is
no game-endpoint namespace to scan.

### Stale Unix game sockets are retried forever without backoff

A game killed with SIGKILL never runs its `Listener::stop`, so its `.sock` file
survives in the runtime directory. `listGameTokens` keeps returning it and
`tryConnectGame` kept retrying every poll for the broker's lifetime, one stderr
line each time. Connection attempts now back off geometrically to a 30 s cap and
stop logging once capped. The file is deliberately not unlinked: the broker
cannot distinguish a dead owner from a live process it merely cannot reach yet,
and deleting a live bridge's socket would strand it.

### The distributed addon layout differs from the scaffold layout

`packaging/conduit.gdextension` maps libraries to
`res://addons/conduit/bin/<lib>`, while `gd_project_scaffold` generates a flat
manifest at `res://addons/conduit/<lib>` with only the host platform's keys,
because it copies exactly one locally built library. The installer follows the
distributed layout, since that is what the release zip contains. The divergence
is intentional but easy to trip over when changing either one.

### Compress-Archive produces forward-slash entry names

The zip reader normalises `\` to `/` in entry names before the traversal check,
because a writer that emitted backslashes would otherwise turn a whole path into
one filename and defeat the check. PowerShell's `Compress-Archive`, which
`scripts/package-addon.ts` uses on Windows, was verified to emit forward slashes
and deflate-compressed entries with no directory records; the normalisation
stays as a guard, not a workaround for an observed bug.

### Godot holds the loaded library after the process is killed

On Windows the editor process retains a handle on `conduit.dll` briefly after
`killTree`, so removing the temporary project directory immediately afterwards
fails with EACCES. The addon eval treats that cleanup as best-effort rather than
racing the OS.

### Boolean environment variables are parsed, not merely tested for presence

Both ends previously treated any non-empty value as on, so `CONDUIT_ENABLE=0`
enabled the bridge. `broker/src/env.ts` and `bridge/src/env.rs` now share one
rule: unset, empty, `0`, `false`, `no`, and `off` are off. Keeping the two
implementations in agreement is load-bearing for `CONDUIT_TCP`, which both ends
read to decide the transport; disagreeing would leave them binding and dialling
different endpoints.

## Commander CLI, tool groups, and the audit log

### Commander does not reject a flag swallowed as an option value

`--project --tcp` parses to `project: "--tcp"` under Commander 15, the same
defect the hand-rolled parser had. Commander allows it deliberately, since a
value may legitimately begin with a dash. `cli.ts` adds a pre-parse pass that
rejects the case where a value-taking option is followed by a token that is
itself a declared long option; a value starting with `--` that is not an option
name still passes through.

### Commander's option defaults would silently kill every environment variable

`program.opts()` cannot distinguish a Commander default from a passed argument,
so any option carrying a `defaultValue` would always look "passed" and its
`CONDUIT_` variable would never be consulted. No option in `cli.ts` has one, and
precedence lives entirely in `resolveConfig`. Commander's own `.env()` support is
also unused: it resolves the variable into the same opts object, hiding the
precedence, and its truthiness rule for booleans contradicts `envFlag`, where
`CONDUIT_X=0` means off.

Booleans are three-state for the same reason: undefined when absent, so
`opts.x ?? envFlag(env.CONDUIT_X)` still consults the variable. Declaring the
positive option before its `--no-` form is what avoids Commander forcing a
`true` default, which it does only when a `--no-x` is declared alone. Verified
against Commander 15.0.0.

### argv shape is the same for bun, node, and a compiled binary

`program.parse(process.argv)` with the default `from: "node"` skips the first two
entries. That is correct for `bun broker/src/index.ts`, for the bundled
`node dist/npm/index.js`, and for a `bun build --compile` executable, which
repeats its own path in `argv[1]`. Confirmed by running a compiled binary with
`--project`, `--version`, and `--help`.

### Help and version output has to be routed away from stdout

Commander writes help and errors to stdout by default, and stdout is the MCP
transport. `program.configureOutput` sends both to stderr; the acceptance is that
`node dist/npm/index.js --help` produces zero bytes on stdout.

### There is no single choke point for tool calls, so the server is proxied

The `makeEditorTool`/`makeGameTool` factories cover about 71 of the 84 default
tools; thirteen call `server.registerTool` directly, including `gd_screenshot`
and `gd_editor_screenshot`, which are exactly the large-payload case the audit
log has to elide. What every path does share is the `McpServer` instance, so
`wrapServer` returns a `Proxy` intercepting `registerTool`. That also keeps the
24 tools registered inline in `index.ts` groupable without extracting them into
modules first, because group membership is a table keyed by tool name rather than
a property of the registration site.

Tools absent from the table pass through unfiltered but still audited. That is
the dynamic `gd_project_*` surface, whose names come from project code at
runtime; it is gated as a whole by `--disable-eval` instead.

### Audit elision must be per field, not per record

Thresholding the serialized record would drop the structured error code along
with the payload it was meant to trim, which is the part worth keeping. The
writer walks `content[]` and replaces oversized `data`/`text` values in place,
keeping `type` and the byte count.

### The audit log defaults off, diverging from section 9

Section 9 phrases the audit log as something the broker writes and that can be
disabled. Conduit inverts the default: writing a file into a user's filesystem is
the same class of act as installing the addon, and `CLAUDE.md` forbids weakening
defaults for convenience. `--audit-log <path>` enables it, `off` disables it
explicitly for configs that can set a variable but not unset one.

### gd_asset_add does not import what it writes; scan_sources does

`asset_add_imports` in the phase 3 runner asserts that Godot has produced a
`.import` sidecar by the time `gd_asset_add` returns, and it fails
intermittently. The cause was measured during phase 13 rather than guessed at:
`gd_asset_add` calls `EditorFileSystem::scan()`, which *discovers* a newly
written source file but does not import it. Only `scan_sources()` does, which is
what `gd_asset_reimport` calls. In a live headless editor the sidecar never
appeared after eight seconds of polling following `gd_asset_add` alone, and
appeared within two seconds of a following `gd_asset_reimport`, repeatedly. The
intermittent green presumably comes from the editor's own periodic source scan
arriving in time.

Chaining `gd_asset_reimport` after `gd_asset_add` makes ingestion deterministic,
which is what `tests/evals/phase13_import.ts` does. Making `gd_asset_add` do
that itself needs a two-stage pending op (scan, then scan_sources), which is a
change to a phase 3 tool and its acceptance, so it is recorded here rather than
folded into an unrelated phase.

### The import pipeline rewrites the .import sidecar it just consumed

Godot rewrites an asset's `.import` file as the last step of importing it. A
`[params]` write issued while an import is still finishing is therefore
silently reverted: `gd_import_settings` reports the previous value and the new
one truthfully, and the pipeline then overwrites the file with the values it
started from. This is not a bridge bug and no locking is available to prevent
it. The phase 13 runner reads through a `settled()` helper that requires the
options, the artifact named in `[remap]`, and that artifact's bytes to be
unchanged across two reads before it trusts a reading or issues a write.

Note also that `EditorFileSystem::is_scanning()` goes false before a queued
reimport has run, so waiting on a rescan is not the same as waiting on an
import. Anything that needs the imported artifact must poll for the artifact.

## Engine installation and the Godot release archives

The engine installer (`broker/src/godot-install.ts`) reads the Godot releases
directly, and four things about those archives are not guessable. All were
checked against the `4.7.1-stable` central directories rather than assumed.

**The .NET asset names differ from the standard ones in three separate ways.**
Not "the standard name with `mono` inserted": Linux swaps the dot before the
architecture for an underscore, Windows drops the `.exe` the standard archive
carries, and only macOS keeps its shape.

```
Godot_v4.7.1-stable_linux.x86_64.zip      Godot_v4.7.1-stable_mono_linux_x86_64.zip
Godot_v4.7.1-stable_win64.exe.zip         Godot_v4.7.1-stable_mono_win64.zip
Godot_v4.7.1-stable_macos.universal.zip   Godot_v4.7.1-stable_mono_macos.universal.zip
```

**The .NET archives unpack one level deeper.** The standard Linux archive is a
single bare executable; the .NET one is a directory named for the build holding
the executable plus `GodotSharp/`. The nesting also renames: the directory is
`..._mono_linux_x86_64` while the binary inside it is `..._mono_linux.x86_64`.
On macOS the bundle is `Godot_mono.app`, not `Godot.app`. `findEngineBinary`
therefore searches one level down as well as directly, and scans for `*.app`
rather than hardcoding either bundle name.

**Every archive is written on a Unix host, so the modes are real and load-
bearing.** The Linux editor arrives `0755` and stops being launchable if
extraction drops that. `zip.ts` originally discarded the external attributes
entirely, which was invisible while it only ever read the addon zip (data and a
library Godot loads, never something exec'd). It now surfaces the mode.

**No archive contains a symlink**, macOS included, which was the open question
that decided whether the in-process extractor was viable there at all. Symlink
handling exists in the installer anyway, because an archive that gained one
would otherwise unpack a text file where a link belongs and fail much later.
Staying in-process is also what keeps macOS quarantine off the result: files the
broker writes itself are not quarantined, while an archive handed to `ditto` or
`unzip` would be.

Checksums are SHA-512 under `SHA512-SUMS.txt`, not the addon's SHA-256 under
`SHA256SUMS.txt`, and entries there are sometimes path-prefixed, so the digest
lookup compares basenames. An exact compare reports a good release as unlisted.

## Phase 10: the target grammar, and what it cannot reach

`docs/coverage-matrix.md` measured the shipped surface against the Godot 4.7
documentation and found 54.3% of the documented engine API reachable only
through eval. Almost all of it traced to one thing: `gd_node_call` and its
siblings took `node_path`, and `resolve_node` went strictly through
`scene_root().get_node_or_null(path)`, so anything not in a scene tree had no
name.

The fix is one optional `target` argument shared by every generic tool on both
bridges, parsed in `bridge/src/handlers/target.rs` and nowhere else. Four tools
on two bridges growing four targeting arguments would have been four grammars.
`node_path` still works and still means a node, so the change is additive: the
old argument's values are a subset of the new one's, and passing both is an
error rather than a silent preference.

`Engine::get_singleton(StringName) -> Option<Gd<Object>>` exists in gdext 0.5.5
as assumed, alongside `has_singleton` and `get_singleton_list`. No dynamic-call
fallback was needed.

**The engine's singleton list is the authority, not the documentation's.**
`@GlobalScope`'s property table lists 41 singletons and is what the coverage
matrix counts, but `Engine::get_singleton_list()` is what actually resolves, and
the two need not agree (editor-only singletons, the `*Manager` classes). The
not-found error quotes the engine's list rather than a hardcoded one, so a
mismatch is self-describing at the point it bites.

### What the property machinery already allowed

`apply_properties` took `Gd<Object>` rather than `Gd<Node>` from the start, so
only naming was missing, not plumbing. The Node-scoped introspection helpers
(`property_names`, `method_names`, `signal_names`) now delegate to Object-scoped
ones; the earlier note in `editor/resource.rs` about `get_property_list` being
reachable "only through each concrete class's own generated Deref chain" is
about generic `Gd<T>` bounds, and does not apply to a concrete `Gd<Object>`.

### gd_scene_node_call is deliberately not undo-wrapped

Every other edit-time mutation goes through `EditorUndoRedoManager`, which
records a do/undo pair. An arbitrary method call has no inverse: there is no
undo for `set_cell` or `bake_navigation_mesh`. Wrapping one as `add_do_method`
with no meaningful undo half would put an entry on the history that `gd_undo`
cannot honour, so `gd_undo` would report success while restoring nothing.

This is the argument `editor/resource.rs` already makes for resources, and it is
resolved the same way: no wrapping, and the response says `undoable: false` so
the property path and the method path can be told apart programmatically. The
caller saves the scene itself.

The same reasoning governs a singleton property write through
`gd_scene_node_set_property`. Engine-global state is not scene state; putting it
on the scene's undo history would let `gd_undo` claim to revert something the
history never owned. Node targets stay undo-wrapped exactly as before, which the
phase 7 `set_property_single_undo` and `set_property_redo` checks still prove.

### What the three verbs did not close

`object`-kind classes -- `PhysicsDirectSpaceState3D`, `SurfaceTool`,
`MeshDataTool`, `EditorSelection`, `RegEx` -- are neither nodes, singletons, nor
resources, and remain eval-only. They have no stable name to put in a `target`:
some are handed out by other calls, some are constructed. Reaching them needs a
handle table with a lifetime, which is a different and larger design than a
resolver, and is why `gd_physics` wraps space-state queries as dedicated ops
instead of exposing the object. Tracked as phase 16 in the coverage matrix.

`ResourceImporter` and its subclasses (`ResourceImporterTexture`,
`ResourceImporterScene`) are in that set, so `gd_import_settings` cannot ask an
importer which options it supports; it reads the ones an asset already has out
of the `[params]` section of its `.import` sidecar. Measured against Godot
4.7.1, that is the same list: a freshly imported 64x64 PNG carries all 23
texture-importer options, and the set was unchanged after a `compress/mode`
write and reimport, which `option_set_is_stable_across_a_write` in the phase 13
runner asserts on every run. That is what makes it safe for the tool to reject
an option name the asset does not already carry rather than inserting it: a key
that is absent is a typo, not a defaulted option. If a future importer writes
its options conditionally, that check goes red and the rejection has to relax to
"absent after a reimport" instead.

### Acceptance runs with --disable-eval

`bun run phase10` drives the whole surface with eval switched off. That flag is
the point of the runner: with `gd_game_eval` and `gd_editor_eval` registered,
every check would pass whether or not any of this code existed.

## Phase 14: shader compilation and diagnostics

### The headless dummy renderer compiles shaders, so no display is needed

The expectation going in was the opposite. `godot --headless` forces the dummy
renderer (above), and shader compilation is a rendering-server concern, so the
tool looked likely to need a real rendering context -- which would have meant
spawning a windowed engine from the user's editor and moving the acceptance
runner into the phase 2/5/6 Xvfb tier.

Measured instead against Godot 4.7.1: the dummy renderer's `shader_set_code`
runs the real `ShaderLanguage` compiler and reports errors. A canvas_item shader
with a syntax error on line 4 prints

```
--Main Shader--
    3 | void fragment() {
E   4->  COLOR = vec4(1.0, 0.0, 0.0 1.0);
SHADER ERROR: Expected ',' or ')' after argument.
   at: (null) (:4)
ERROR: Shader compilation failed.
   at: shader_set_code (servers/rendering/dummy/storage/material_storage.cpp:192)
```

All five documented shader types (`canvas_item`, `spatial`, `particles`, `sky`,
`fog`) compile clean there, and a deliberate error in a `spatial` shader is
diagnosed the same way, so this is not a canvas-only path. `gd_shader_validate`
is therefore `--headless` like `gd_script_validate`, needs no display, and
`bun run phase14` sits in `ci:phases`.

The one place the dummy renderer shows through: a missing or unrecognised
`shader_type` is reported as `ERROR: Shader type <name> not supported in Dummy
renderer.` That is a real defect in the shader -- the five real types all work --
but the wording blames the renderer, which would read as a defect in the tool.
The handler restates it in the shader's own terms, and the phase 14 runner
asserts that "Dummy" never reaches the caller. If a future Godot adds a shader
type the dummy renderer does not implement, that normalisation would turn a tool
limitation into a false "unknown shader_type", and this is the check that would
need revisiting.

### Loading a shader resource does not compile it

`ResourceLoader.load` on a broken `.gdshader` reports nothing at all: it returns
a valid `Shader` object and prints no diagnostic. `Shader.get_shader_uniform_list()`
is what forces the compile, and the errors appear synchronously inside that
call. A validator built on load alone would report every broken shader as valid,
which is why the driver script calls it and why that call is not incidental.

`Shader` has no member that reports compile status (`get_default_texture_parameter`,
`get_mode`, `get_shader_uniform_list`, `inspect_native_shader_code`,
`set_default_texture_parameter`, and the `code` property are the whole surface in
the 4.7 reference), so the verdict cannot come from the object. It comes from the
output, and `gd_shader_validate` contributes no entry to `coverage-map.ts` for
the same reason `gd_script_validate` does not: there is no engine member it
fronts.

### The subprocess route, and why the log route was not retried

`gd_shader_validate` spawns `godot --headless --path <project> --script <driver>
-- <shader path>` and reads the child's captured stdout/stderr after `try_wait`
reports it exited, exactly as `gd_script_validate` does. The in-process
alternative -- compile in the editor and tail its own log -- was not attempted,
because the finding that moved `gd_script_validate` off `log_tail` (above) is
about the editor process's log writer and not about GDScript: diagnostics
emitted by the editor are not visible to a reader inside that same process on
any bounded wait. `log_tail`'s module comment still advertises a
`gd_script_validate` cursor that no longer exists; the only remaining consumer is
`runtime/observe.rs`.

Two mechanics settled by the same probe:

- `--script` accepts an absolute path outside the project, so the driver script
  is written to the OS temp directory and the user's project is never touched.
  The fallback, had it not worked, was a dot-prefixed file in `res://`.
- The child exits 0 whether or not the shader compiled, because a compile
  failure is not observable from GDScript and the driver has nothing to report.
  Output is the only verdict signal, which is the same conclusion `--check-only`
  forced on macOS. `exit_code` is still returned so a future divergence is
  visible without a CI round-trip.

Cost is one engine startup per call: 566 ms against `example-project` on
Windows, comparable to `gd_script_validate`.

### Only the first shader error is reported, and a broken #include is misattributed

The shader compiler stops at the first error, so `diagnostics` carries at most
one entry -- unlike `gd_script_validate`, which can return several. This matches
the engine's own shader editor.

A `#include` of a path that does not exist produces no preprocessor diagnostic.
The preprocessor fails silently and leaves the code without a reachable
`shader_type`, so the error surfaces as the missing-`shader_type` message
instead of naming the include. Valid includes work normally. The
missing-`shader_type` message says so explicitly rather than pretending the
declaration is simply absent.

### gd_animation still creates value tracks only

`bridge/src/handlers/runtime/animation.rs` creates `TrackType::VALUE` and
nothing else. This is left as it is: `Animation.add_track`, `track_insert_key`,
and the rest of the track API are reachable through `gd_resource_call` on both
bridges, so it is a convenience gap in a dedicated tool rather than a capability
gap in the surface. Phase 14's rule pass grades the animation-track headings on
that basis.

## Phase 15: editor plugins and translations

### A headless editor does load an enabled plugin

The expectation going in was that `EditorInterface.set_plugin_enabled` might be
inert under `--headless --editor`, on the theory that an `EditorPlugin` is a
`Node` added to editor UI that a headless session does not build. Measured
instead against Godot 4.7.1: it loads the plugin and runs its `_enter_tree`
synchronously, and `_exit_tree` on disable. The phase 15 runner proves it with
a fixture plugin that appends a line to a marker file from each, and reads the
file back from the host side.

That is why the runner passes `render: false` to `godotCommand`, never calls
`requireDisplay()`, and joins `ci:phases` alongside phases 13 and 14 rather
than the local-only rendering tier. What would invalidate it is a plugin that
touches a `Control` or a dock: those paths are not exercised here, and a
fixture that built UI could fail headless while this one passes. The fixture is
deliberately UI-free for that reason, not incidentally.

### set_plugin_enabled reports nothing, so the flag is read back

The method returns `void`. A plugin whose script fails to parse leaves the
enabled set unchanged and reports the failure only to the editor log, so a
handler that trusted its own argument would answer `enabled: true` for a plugin
that never loaded. `bridge/src/handlers/editor/plugins.rs` calls
`is_plugin_enabled` afterwards and turns a mismatch into a `resource_error`
naming the likely cause.

The acceptance draws the same distinction one level up: asserting
`is_plugin_enabled` is true would pass while `_enter_tree` never ran, so
`plugin_enable_loads_it` requires the marker file as well as the flag.

### The enabled set is stored, but not under the key that names it

`project.godot` is an INI file and a setting key splits at its first slash, so
`editor_plugins/enabled` is written as `enabled=` under `[editor_plugins]` and
`internationalization/locale/translations` as `locale/translations` under
`[internationalization]`. The dotted key never appears in the file as written.

This is recorded because it is a trap for acceptance checks rather than for the
handlers: the first cut of the phase 15 runner grepped the file for the full
key, which finds nothing whether or not the setting persisted -- a check that
passes for the wrong reason on the way to failing for the wrong reason. The
runner now parses the section and the key out of it, and reads a dictionary
value to the next key rather than to the end of the line, because
`locale/translation_remaps` spans several lines and a one-line read returns a
bare `{`.

### POT extraction has no scripted entry point

`gd_translations` covers the four `internationalization/locale/*` settings the
Localization tab writes. It does not generate a `.pot`, because the generator
is `EditorNode`'s own `POTGenerator`, invoked from the Localization dialog's
Generate POT button and exposed nowhere in `ClassDB`. `EditorTranslationParserPlugin`
lets a project contribute *to* that generation; it does not let anything
trigger it.

Shipping `pot_add`/`pot_remove` over `internationalization/locale/translations_pot_files`
was considered and rejected: it would manage the source list for a button
nothing can press, which reads as a capability and is not one. This is the same
judgment phase 14 made for `LightmapGI` baking. If a future Godot exposes the
generator, the tool gains two ops and this note goes away.

### set_locale cannot restore a locale to its engine default

`internationalization/locale/fallback` has an engine default of `en`, and
`gd_translations set_locale` writes over it but has no op that erases it: a
blank `fallback` is rejected as a malformed locale rather than treated as
"clear this". So an agent that sets a fallback can change it again but cannot
put the key back in the state a fresh project has, short of
`gd_project_set_setting` writing `en` explicitly.

The asymmetry with `add`/`remove` is deliberate rather than an oversight. A
translation list has a meaningful empty state and `remove` reaches it, so the
setting can be erased outright. A fallback locale does not: every project has
one whether or not `project.godot` names it, so "no fallback" and "the default
fallback" are the same state, and an op that erased the key would differ from
one that wrote `en` only in the file, never in behaviour. `test` takes an empty
string because the editor writes one there for "no override", which is a real
value rather than an absence.

## Phase 16: object handles

### A dead handle is a lookup, never a dereference

`Gd<T>` for a manually managed object is a raw pointer with no ownership, and
gdext documents access to a dead object as safe but panicking "in a defined
manner". A panic inside a handler is caught at the dispatcher boundary and
returned as `internal_error`, which would be a true statement about the bridge
and a useless one about the object.

So `bridge/src/handles.rs` never dereferences the stored pointer. Each entry
keeps an `InstanceId` and resolves through `Gd::<Object>::try_from_instance_id`,
which returns `Result`, and keeps a strong `Gd<Object>` only when the object is
`RefCounted` -- where holding it is what keeps the object alive. For a manually
managed object the table deliberately holds no pointer at all, so there is
nothing that could dangle. `list` reports `valid` from the same lookup, so a
dead handle is visible before it is used and not only when it is.

Measured against Godot 4.7.1 by the phase 16 runner: capturing a node, freeing
it with `gd_tree_mutate free`, and calling through the handle two frames later
answers `object_not_found` naming the class, and `list` shows `valid: false`.

### create builds only RefCounted classes

The restriction is what lets `release` promise it neither frees something out
from under a caller nor leaks: for a `RefCounted` object the handle *is* the
ownership, so dropping it is the whole of the cleanup.

Freeing on release was considered and rejected. An agent can hand a constructed
object to something that keeps it -- `TileSet.add_source` is exactly that, and
the phase 16 runner does it -- so a release that freed would destroy a live
sub-resource. Not freeing, on a manually managed object, leaks it for the life
of the process instead. Refusing to construct one avoids the choice.

The cost is close to zero. The manually managed members of this cluster are not
instantiable anyway: `PhysicsDirectSpaceState3D`, `EditorSelection`, `TileData`
and their kind are handed out by a call, which is what `capture` is for. Nodes
have `gd_tree_mutate add_node` and `gd_node_add`, and the refusal names them.

### The engine answers with its implementation class, not the documented one

`World3D.direct_space_state` is documented as `PhysicsDirectSpaceState3D`. What
`get_class()` returns is `GodotPhysicsDirectSpaceState3D`, the concrete
implementation behind the abstract documented type. A handle reports the class
the engine gives, so a caller matching an exact documented name would find
nothing; the phase 16 runner asserts the documented name is a *substring*, and
this is recorded because it is a trap for any check written against the class
reference rather than against the running engine.

### Capture is top-level only

`capture: true` inspects the value the call returned and nothing inside it.
Objects nested in a returned array or dictionary stay stringified, so
`intersect_ray`'s `collider` reads as `Body3D:<StaticBody3D#27296531943>` and
cannot be acted on without finding it again by path.

This is a deliberate boundary rather than an oversight. `variant_to_json`
recurses, and minting inside it would take handles on every object in every
returned container -- including nodes that already have paths -- filling a
64-entry table with entries nobody asked for. Closing this properly needs a way
to say *which* nested value to capture, which is a path expression and a
different design. Until then the honest answer is that the top level is what
capture covers.

### Handles grant no authority the target grammar did not already grant

There is no flag on `gd_object` or `gd_scene_object`, and that is a decision
rather than an omission. `gd_node_call target=singleton:OS method=execute` is
reachable in a default deployment today, so the surface already permits calling
arbitrary engine methods on engine objects; a handle changes which objects can
be named, not what may be done to one. Both tools sit in the `object` group and
`--tool-groups` subtracts them like any other.

### A typed array used to report itself as empty

Found by the phase 16 runner rather than reasoned about: `get_selected_nodes`
on a captured `EditorSelection` returned `[]` while the editor's own selection
was `["Player"]`.

The cause is not selection and not handles. gdext's `Array<T>` checks its
runtime element type on conversion (`with_checked_type`), so a `TypedArray<Node>`
cannot become the untyped `Array<Variant>`; `variant_to_json` swallowed that
error with `unwrap_or_default()` and returned an empty array. Every dynamic call
returning a typed array -- `get_children`, `get_selected_nodes`, any
`Array[String]` -- had been answering with a wrong value rather than an error,
on both bridges, since the conversion was written.

`variant_array_items` now falls back to reading through the Variant's own
`size`/`get`, which is type-agnostic. The dictionary arm gets the same treatment
for the same reason, since Godot 4.4 typed dictionaries fail the same check.

`Variant::call` panics rather than erroring when a method does not exist or the
arity does not match, so a fallback that guessed at signatures would trade a
wrong answer for an `internal_error`. The signatures were checked against
gdext's generated builtin method table rather than assumed: `Array.size()` and
`Array.get(index)`, `Dictionary.keys()` and `Dictionary.get(key, default)` --
`get` takes two required parameters there, not one with a default, which is why
the call passes an explicit `Variant::nil()`. Only the array half has an
acceptance check (`a_typed_array_reports_its_elements` in the phase 16 runner),
because that is the half something in the surface was observed to hit; the
dictionary half rests on the signature check alone.

### Editor selection does survive a headless editor

The phase-15 note warns that plugin paths touching a `Control` or a dock are
unproven headless, and selection looked like that kind of path. Measured
instead: `gd_editor_select` under `--headless --editor` sets the selection,
`gd_editor_get_state` reads it back, and `EditorSelection.get_selected_nodes`
through a captured handle agrees with both. The phase 16 runner asserts the
third of those, so the runner needs no display and joins `ci:phases`.

## Phase 17: signals on any target

### A custom Rust callable connects to a signal of any arity

The blocker for a native `await` was arity. `#[func]` has no varargs form in
gdext 0.5.5, so the `ConduitEvalSink` idiom -- a `RefCounted` class with a fixed
method signature -- cannot receive `SceneTree.node_added` (one argument) and
`SceneTree.process_frame` (none) through one implementation. A signal name
arrives as a string at run time, so there is no place to pick a sink class from
a set of them either.

`Callable::from_fn(name, |args: &[&Variant]| ...)` has no such count. gdext
builds it as a custom callable and leaves `get_argument_count_func` unset, so
the engine never asks. Measured rather than assumed: the phase 17 runner awaits
the zero-argument `process_frame`, `timeout` and `renamed`, the one-argument
`node_added`, and the two-argument `Input.joy_connection_changed`, asserting the
argument count each time.

`from_fn` is single-threaded by construction, which is exactly the constraint
the bridge already lives under -- everything here runs on the main thread inside
`_process`.

### ONE_SHOT is not enough cleanup on its own

`ConnectFlags::ONE_SHOT` drops the connection when the signal fires. It does
nothing for the other settle path: a signal that never fires, where the pending
op gives up at its frame deadline. A callable made with `from_fn` is not tied to
any object's lifetime the way `from_linked_fn` is, so an abandoned connection
would outlive the request that made it. `SignalWait::disconnect` therefore runs
on every settle path, guarded by a validity check, and is a no-op in the fired
case because ONE_SHOT already removed the connection.

### An emitter that dies mid-await

Same rule as the handle table, for the same reason: the pending op holds an
`InstanceId` and re-resolves through `try_from_instance_id` on each poll rather
than holding a `Gd`. A `Tween`, a `SceneTreeTimer`, or a captured node can be
freed while the await is suspended, and the answer has to be `object_not_found`
rather than a dereference. The runner asserts the pre-resolution case (a handle
whose node was freed before the call); the mid-wait case takes the same code
path one poll later.

### The exposed connect API carries flags, but only under another name

`Object::connect_ex` is `pub(crate)` in gdext 0.5.5 -- the generated builder
exists but is `raw_connect_ex`. The public way to pass `ConnectFlags` is
`Object::connect_flags(signal, callable, flags)`, in
`godot-core/src/classes/type_safe_replacements.rs`, which also registers custom
callables for hot-reload cleanup. `connect_ex` compiles nowhere; the editor
handler's older idiom of a dynamic `call("connect", [signal, callable, flags])`
through the undo manager still works and is still what the persisted path uses,
because that path needs the call to be a recorded undo action rather than a
direct one.

### --disable-eval was not previously complete

The eval-backed `await` meant the bridge compiled and ran a GDScript snippet in
a deployment that had passed `--disable-eval` to drop exactly that machinery.
The snippet was generated and its one interpolation was a JSON-escaped string
literal, so it was not an injection hole and no acceptance check was wrong; but
the flag's promise and the code disagreed, and phase 17 removes the disagreement
rather than documenting it as intended. `--disable-eval` is a broker-side tool
filter, so a bridge handler that reaches `run_source` is invisible to it: that
is worth remembering the next time a handler wants to generate GDScript.

### An edit-time await settles under a headless editor

The editor throttles hard when idle (see the phase 5 note), which made it an
open question whether a pending op in the editor bridge polls often enough for
an await to settle. It does: the phase 17 runner awaits
`EditorSelection.selection_changed` and `Resource.changed` under
`--headless --editor` with `--disable-eval`, both settle in well under the
request timeout, and the runner needs no display and joins `ci:phases`.

### Not every property setter emits Resource.changed

The resource-signal check triggers `changed` with `Resource.emit_changed`
through `gd_resource_call`, not by writing a property. `Curve.bake_resolution`
was tried first and does not notify -- its setter marks the bake cache dirty
and returns. Which setters notify is a per-class detail of the engine and not
what the check is about, so the trigger is the engine's own explicit one. The
check still goes through the `res://` path rather than through the handle,
because that is what proves `ResourceLoader`'s cache hands both doors the same
instance.

### A persisted connection needs both ends inside the edited scene

`gd_scene_signal connect` splits on whether *both* ends are nodes of the edited
scene: two such nodes get `CONNECT_PERSIST` and an undo action, as before;
anything else gets a live connection reported as
`persisted: false, undoable: false`. Both ends, because a persisted connection
serializes the receiver into the scene file too, so a singleton at either end is
enough to make persistence impossible. The argument is the
one `gd_scene_node_call` and the singleton property write already make -- there
is no scene file for a singleton's connection to serialize into, and the edited
scene's history does not own it, so an undo entry would be a claim `gd_undo`
could not honour. The runner asserts both halves: the singleton connect leaves
the saved `.tscn` with no `[connection]` section, and the node-to-node connect
still writes one.

## Phase 18: the measurement, and what the compute page actually reaches

### A local RenderingDevice needs a RenderingDevice-based renderer

`RenderingServer.create_local_rendering_device()` answers `null` unless the
running engine uses a renderer built on `RenderingDevice`. Two deployments this
repository uses do not:

- `--headless` forces the dummy rendering driver, and it answers `null` whatever
  `--rendering-method` says. Passing `--rendering-method forward_plus` alongside
  `--headless` does not change the answer; this was measured, not inferred from
  the driver's name.
- `example-project` ships `renderer/rendering_method="gl_compatibility"`, and the
  Compatibility renderer is not `RenderingDevice`-based, so a windowed editor on
  the project's own setting answers `null` too.

`bun run phase18` therefore launches a windowed editor with
`--rendering-method forward_plus` explicitly, and it is not in `ci:phases`, for
the reason phase 6 is not: it needs a display, and here also a GPU whose driver
carries a real `RenderingDevice`. Under those conditions the call returns a
device, `capture: true` takes a handle on it, and `get_device_name` answers on a
later call from that handle -- which is what licenses grading "Create a local
RenderingDevice" T1 rather than T2.

### An RID has no JSON form, so the compute pipeline stops at the device

Every step of the compute workflow after the device exchanges RIDs:
`storage_buffer_create`, `shader_create_from_spirv`, `uniform_set_create`, and
`compute_pipeline_create` each return one, and the calls that consume them want
one back. `variant_json.rs` has no RID case -- RID joins `Callable` and `Signal`
in the "no meaningful JSON form" branch -- so a returned RID stringifies to its
display form, `RID(509086768562176)`.

That string cannot be spent. It is a `String` by the time it reaches
`json_to_variant`, and the method wants an `RID`. So phase 18 split
`t2:compute_shader` rather than flipping it: obtaining the device is T1, and the
six headings built on the device stay T2 for the RID gap, not for the handle gap
the rule used to cite. Closing it needs a scheme in the same family as
`object:<n>` -- a name for a value the wire cannot carry -- which is named in the
matrix's `### Next` rather than shipped here.

### A wrong-typed argument panics inside Object::call

Feeding that stringified RID back to `buffer_get_data` does not produce a typed
error. gdext's `Object::call` panics on an argument type mismatch, the
dispatcher's `catch_unwind` (`bridge/src/dispatcher.rs`) contains it, and the
client sees `internal_error: internal error: handler panicked`.

The bridge stays up, so this is a reporting defect rather than a safety one, but
it diverges from the structured error model of whitepaper section 7.4: the
caller cannot tell a bad argument from a genuine internal fault. gdext 0.5.5
exposes no `try_call` on `Object` to fall back to, so a fix means validating
arguments against the method's `ClassDB` signature before dispatching. Phase 18
is a measurement phase and did not take that on; the acceptance asserts only
that the call *fails*, deliberately not that it fails this way, so a later fix
to a typed error does not break the runner.

### The tutorial rules had no staleClaims, and rotted for two phases

`staleClaims` has validated the class-reference coverage map against the
documentation since the audit shipped, and it is fatal. The tutorial rules had
no equivalent, which is why phases 16 and 17 could close gaps that three
`section-rules.ts` entries went on citing -- one of them naming the phase that
closed it ("out of reach until phase 16").

`staleSectionRules` is now fatal in the same place, and the check has to be
"never wins a heading", not "matches something in isolation": `matchSection` is
first-match-wins and several rules use `match: [""]` to claim a whole page, so a
fully shadowed rule still matches everything when asked on its own. It applies
to action rules only -- a concept needle exists to keep prose out of the
denominator, and a list of them that over-provides costs nothing. On its first
run it found `t0:screenshot`, an action rule claiming T0 coverage for headings
no page in the corpus has; it was removed rather than kept as a claim reaching
nothing.

Placing it there only half-closes the hole, and the other half is worth stating.
Both guards run inside `bun run coverage`, so they fire when the matrix is
regenerated -- and regeneration stores a new 8 MB LFS version, which `CLAUDE.md`
reserves for when the numbers are actually wanted. A phase that edits
`section-rules.ts` and skips the regeneration is the likely path, and it is the
path that produced this rot in the first place.

`bun run coverage:check` is the answer: it runs the audit and both guards,
prints the tier summary so a rule edit's effect is visible, and writes nothing,
so it costs no LFS. It still needs `CONDUIT_GODOT_DOCS`, so it cannot run in CI
without a documentation checkout -- and neither could any check that grades
rules against the real reference. Run it after touching either rule table.

A committed corpus fixture would have made the check CI-runnable, and was
rejected: 405 KB of heading data duplicating what `coverage-matrix.json`
already holds, needing its own regeneration to stay honest, for a check whose
whole purpose is catching data that drifted out of sync.
