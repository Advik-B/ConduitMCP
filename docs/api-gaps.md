# API gaps and environment notes

Where the whitepaper's assumed API differs from the gdext/Godot version in use
(gdext 0.5.4, Godot 4.7.1), or where an environment constraint shaped the
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

## Typed collections in gdext 0.5.4

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

## Cross-platform transport: Windows named pipes need a two-thread serve

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
with `Stream::split()` and the read and write halves on separate threads -- a
reader parked in a blocking read feeding `inbound_tx`, and a writer draining
`outbound_rx`/`event_rx` with blocking writes. Backpressure `busy` responses are
routed from the reader to the writer over an internal channel rather than written
to the pipe directly (only one thread may write). This preserves the
write-while-blocked-on-read property that deferred `await` completions and
debugger events require, validated by the phase 1 stress acceptance on Windows.
The proven Unix non-blocking loop is left unchanged. An opt-in loopback TCP
fallback (`CONDUIT_TCP`) exists for the editor connection.

One shutdown caveat: a Windows reader thread parked in a blocking read is
detached, not joined, so joining it can never hang `Listener::stop()`; it ends
when the peer disconnects or the process exits. Phase 9 found a different stop
hazard in this same function (a second stop from Drop blocking in the wake
connect) and made `stop()` idempotent; see the phase 9 section.

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

The `await` op is implemented by delegating to the evaluation runner with a
generated `return await Signal(get_node(path), signal)` snippet. Awaiting a
signal yields its first argument, and the wait is bounded by the broker's
per-request timeout rather than an in-snippet timeout. Connect, disconnect,
emit, and list are direct synchronous calls.

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
`set_script`/`get_script`; that is stale. gdext 0.5.4 provides both as
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

gdext 0.5.4 generates no bindings for `NavigationServer2D/3D` or
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
