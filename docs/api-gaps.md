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

Matrix and transform Variant types (`Basis`, `Transform2D`, `Transform3D`,
`AABB`, `Plane`, `Projection`) are not yet tagged: `variant_to_json` stringifies
them rather than dropping the value, and `json_to_variant` returns an
`invalid_args` error for their `__type`. The common scalar, vector, colour,
rect, quaternion, and packed-array types are fully supported both directions.
Tagging the matrix/transform types is follow-up work.

## Typed collections in gdext 0.5.4

`Dictionary` and `Array` are generic in this gdext version; the untyped forms are
`VarDictionary` (`Dictionary<Variant, Variant>`) and `VarArray`
(`Array<Variant>`). `Object::get_property_list` and friends return
`Array<VarDictionary>`.

## Local socket path length

Unix domain socket paths must fit `sun_path` (~108 bytes). The runtime directory
holding the endpoints (`CONDUIT_RUNTIME_DIR`, default the system temp dir) must
therefore be short; a deeply nested directory makes the bind fail with
"local socket name length exceeds capacity of sun_path". The default `/tmp` is
fine; the acceptance harness uses `/tmp/conduit-p2`.

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

`Object` has no public `set_script`/`get_script` in this gdext version (only
`pub(crate) raw_set_script`/`raw_get_script`). `script` is reached through the
generic dynamic property API (`add_do_property`/`add_undo_property(node,
"script", variant)`), the same mechanism as any other property.

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
