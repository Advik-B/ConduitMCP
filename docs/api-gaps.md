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
