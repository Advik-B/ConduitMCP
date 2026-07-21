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
