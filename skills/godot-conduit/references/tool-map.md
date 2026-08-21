# The full tool surface

Every Conduit tool, which bridge it routes to, and its `--tool-groups` group. Tools marked
"flag" are not registered unless the operator opted in.

Bridge column: **editor** needs a connected Godot editor, **game** needs a running game
launched with `gd_play`, **broker** needs neither.

Consolidated tools take an `op` (or `device`, or `mode`) discriminator; the op list is in the
tool's own schema description, which is the authority. This file is a map, not a schema.

## Contents

- [Session and status (core)](#session-and-status-core)
- [Running and observing the game (runtime)](#running-and-observing-the-game-runtime)
- [Runtime systems](#runtime-systems)
- [Networking (net)](#networking-net)
- [Editing scenes (scene, wiring)](#editing-scenes-scene-wiring)
- [Scripts and resources (script, resource)](#scripts-and-resources-script-resource)
- [Project configuration (project, state)](#project-configuration-project-state)
- [Assets, files, export (assets, files, export)](#assets-files-export-assets-files-export)
- [Debugging (debug)](#debugging-debug)
- [Editor collaboration (collab)](#editor-collaboration-collab)
- [Reflection (classdb)](#reflection-classdb)
- [Object handles (object)](#object-handles-object)
- [Static calls and RIDs](#static-calls-and-rids)
- [Evaluation (eval)](#evaluation-eval)
- [Pixel fallback (pixel)](#pixel-fallback-pixel)
- [Project-defined tools](#project-defined-tools)

## Session and status (core)

The `core` group is always registered and cannot be dropped, so a slimmed deployment stays
diagnosable and completable.

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_status` | broker | Editor connection, engine version, connected games, resolved engine binary, addon state. The first call of a session. |
| `gd_ping` | editor | Round-trips the editor bridge to prove it is responsive. |
| `gd_game_list` | broker | Connected game instances with pid and engine version. |
| `gd_get_events` | broker | Lifecycle events since a cursor: game started, game exited, editor disconnected, addon install progress. |
| `gd_addon_status` | broker | Whether the directory is a Godot project, and whether the addon is missing, current, stale, or unmanaged. |
| `gd_addon_install` | broker | Installs or repairs the addon and registers the `ConduitRuntime` autoload. Refused while an editor is connected. |
| `gd_project_scaffold` | broker | Creates a minimal project in an empty directory. The one capability that cannot require an editor. |
| `gd_engine_status` | broker | Whether an engine binary is available, whether a Godot is already running that the broker did not start, and which builds it has installed. Call before launching or installing. |
| `gd_engine_install` | broker | Downloads a Godot editor into the broker's engine directory. `mono=true` for the .NET/C# build. Only needed when no engine is present. |
| `gd_editor_launch` | broker | Spawns the editor on the configured project and waits for its bridge. `headless=true` for scripted sessions. Refuses when a Godot it did not start is already running. |
| `gd_editor_quit` | broker | Asks the editor to quit and confirms it exited. Unsaved editor state is discarded. |

## Running and observing the game (runtime)

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_play` | editor | Runs the game and waits for its bridge. `scene` takes `main`, `current`, or a `res://` path. |
| `gd_stop` | editor | Stops the running game. |
| `gd_find_nodes` | game | Finds live nodes by class, group, or name glob. Paginated. |
| `gd_tree_get` | game | Dumps the live tree from a root, depth-limited. |
| `gd_node_get_info` | game | A node's class, children, and property, signal, and method names. |
| `gd_node_get_property` | game | Reads one live property. |
| `gd_node_set_property` | game | Writes one live property, returning the previous value. |
| `gd_node_call` | game | Calls a method on a live node. |
| `gd_signal` | game | Live signals on any target: `connect`, `disconnect`, `emit`, `list`, `await`. `target` names the emitter, `receiver` the connection destination; `await` returns every argument the signal carried. |
| `gd_input` | game | Simulated input by `device`: key, action, mouse button and motion, joypad button and axis, touch, drag, magnify, pan. |
| `gd_screenshot` | game | The game's rendered frame, as an image block. `not_available_headless` under `--headless`. |
| `gd_perf` | game | Framerate, frame time, memory, object, node, and draw-call counts. |
| `gd_get_logs` | game | Log output appended since the last call. |
| `gd_get_errors` | game | New error and warning lines since the last call. |
| `gd_pause` | game | Pauses or unpauses the scene tree. |
| `gd_step_frames` | game | Advances a paused game a precise number of frames, then restores the pause state. |
| `gd_wait_frames` | game | Waits a number of rendered frames. The deterministic wait. |
| `gd_wait_time` | game | Waits a number of seconds of game time. |
| `gd_set_time_scale` | game | Engine time scale, where 1.0 is normal. |

## Runtime systems

Each is one tool with an `op` discriminator, in its own group so it can be dropped.

| Tool | Group | What it covers |
| --- | --- | --- |
| `gd_tree_mutate` | tree | Live tree structure: `instantiate`, `add_node`, `free`, `reparent`, `change_scene`. No undo. |
| `gd_physics` | physics | Raycasts, point and shape intersections, navigation paths and baking, world gravity and tick. `dimension` picks 2D or 3D. |
| `gd_render` | render | Cameras, world environment, viewport settings, and debug draw of lines, circles, rects, spheres, and boxes. |
| `gd_audio` | audio | Bus list, volume, mute, solo, sends, bus effects, and `AudioStreamPlayer` transport. Works headless under the dummy driver. |
| `gd_animation` | animation | `AnimationPlayer` transport, property tweens, runtime animation authoring, `AnimationTree` state machines, `Skeleton3D` bone poses. |
| `gd_tilemap` | tilemap | `TileMapLayer` and `GridMap` cells. The deprecated `TileMap` node is rejected. |
| `gd_window` | window | Window geometry and mode, display server identity, OS info, locale. Setters are accepted no-ops headless and the result is echoed back. |

## Networking (net)

Eval-class: dropped by `--disable-eval` along with the eval tools, because reaching the network
on the agent's behalf is the same order of capability.

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_http_request` | game | HTTP(S) from the running game. Body truncated at `max_body_bytes` with an explicit marker. |
| `gd_websocket` | game | WebSocket client: `connect`, `send`, `recv`, `close`, `status`. |
| `gd_multiplayer` | game | ENet lifecycle and RPC: `create_server`, `create_client`, `disconnect`, `status`, `rpc`, `rpc_config`. |

## Editing scenes (scene, wiring)

Every mutation here goes through the editor's own undo history, so `gd_undo` reverses it and
the human's undo stack stays coherent. Paths are relative to the edited scene root.

| Tool | Group | What it does |
| --- | --- | --- |
| `gd_scene_open` | scene | Opens a scene by `res://` path as the active tab. |
| `gd_scene_create` | scene | New scene with a chosen root type, saved to a path. Overwrites. |
| `gd_scene_tree_get` | scene | The edited scene as JSON, depth-limited, with each node's attached script. |
| `gd_scene_find_nodes` | scene | Finds nodes in the edited scene by class, group, or name glob. Paginated. |
| `gd_scene_node_get_property` | scene | Reads one property of an edited-scene node. |
| `gd_scene_node_set_property` | scene | Writes one property, undo-wrapped, returning the previous value. |
| `gd_scene_node_call` | scene | Calls a method on an edited-scene node or a singleton. Not undo-wrapped; save the scene afterwards. |
| `gd_node_add` | scene | Adds a child node of a given engine class, with optional initial `properties`. Owner set so it persists. |
| `gd_scene_instantiate` | scene | Instantiates another scene as a child. Only the instance root is owned by the edited scene. |
| `gd_node_remove` | scene | Removes a node. |
| `gd_node_rename` | scene | Renames a node. |
| `gd_node_reparent` | scene | Moves a node to a new parent, preserving global transform. |
| `gd_node_duplicate` | scene | Duplicates a node and its subtree as a sibling. |
| `gd_scene_save` | scene | Saves the active scene, or saves-as to a path. |
| `gd_scene_save_all` | scene | Saves every open scene. |
| `gd_scene_signal` | wiring | Signals at edit time: `connect`, `disconnect`, `emit`, `list`, `await`. A node-to-node connect is `CONNECT_PERSIST` and serialises on save, and the target method need not exist yet; a `singleton:` or `object:` source connects live and reports `persisted: false`. |
| `gd_node_group` | wiring | Persistent groups: `add`, `remove`, `list`. |

## Scripts and resources (script, resource)

| Tool | Group | What it does |
| --- | --- | --- |
| `gd_script_create` | script | Writes a GDScript file from an `extends` template or literal source. Overwrites. Does not compile-check. |
| `gd_script_validate` | script | Reloads a script through the engine and reports compile diagnostics with line numbers. No game launch. |
| `gd_script_attach` | script | Attaches an existing script to an edited-scene node, undo-wrapped. |
| `gd_script_detach` | script | Removes the attached script. |
| `gd_shader_validate` | script | Compiles a `.gdshader` through the engine and reports diagnostics with line numbers. Headless; no display needed. |
| `gd_resource_create` | resource | Creates a resource of a given engine class at a `res://` path. Returns its type and `uid://`. |
| `gd_resource_set_property` | resource | Writes one property of a resource file and re-saves it. |
| `gd_resource_get_property` | resource | Reads one property of a resource file, or lists its property names. |
| `gd_resource_call` | resource | Calls a method on a resource file, re-saving unless `save: false`. |

## Project configuration (project, state)

Not undo-wrapped: these write `project.godot` or act on editor state directly.

| Tool | Group | What it does |
| --- | --- | --- |
| `gd_project_get_setting` | project | Reads one setting by its `project.godot` key. |
| `gd_project_set_setting` | project | Writes one setting and saves `project.godot`. |
| `gd_autoload` | project | Autoload singletons: `list`, `add`, `remove`. Applies to subsequently launched games. |
| `gd_input_map` | project | Input actions and their bound events: `list`, `add_action`, `remove_action`, `add_event`, `remove_event`. Applies to subsequently launched games. |
| `gd_editor_plugin` | project | Editor plugins under `res://addons`: `list`, `enable`, `disable`. `plugin` is the directory name, not a path. Takes effect in the running editor at once. |
| `gd_translations` | project | Project translations: `list`, `add`, `remove`, `remap_add`, `remap_remove`, `set_locale`. Registers imported `.translation` files; POT extraction is an editor menu action with no API. |
| `gd_undo` | state | Reverses the most recent undo-wrapped edit. Reports `performed: false` when there is nothing to undo. |
| `gd_redo` | state | Reapplies the most recently undone edit. |
| `gd_editor_get_state` | state | Open scenes and their dirty flags, current scene, selection, and whether a game is playing. |

## Assets, files, export (assets, files, export)

| Tool | Group | What it does |
| --- | --- | --- |
| `gd_asset_add` | assets | Writes base64 bytes to a project path and waits for the import to settle. Returns the imported type and `uid://`. |
| `gd_asset_reimport` | assets | Reimports an asset after its import settings changed. |
| `gd_import_settings` | assets | Reads (`op=get`) or writes (`op=set`) an asset's `.import` options, reimporting after a write unless `reimport=false`. An option the asset does not already have is an error, not a silent insert. |
| `gd_file_move` | files | Moves or renames a file, carrying its `.uid` sidecar so `uid://` references survive. Plain `res://` references are not rewritten. |
| `gd_file_delete` | files | Deletes a file with its `.uid` and `.import` sidecars. |
| `gd_export_presets` | export | Lists presets from `export_presets.cfg`. |
| `gd_export_project` | export | Headless export through a preset. `mode=pack` needs no export templates; `debug` and `release` do. |

## Debugging (debug)

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_debug` | editor | Breakpoints (`set_breakpoint`, `clear_breakpoint`, `list_breakpoints`), execution (`break`, `continue`, `step_over`, `step_into`), and inspection (`stack`, `vars`). Breakpoints can be set before the game runs; the rest needs a game. |

While a game is halted, every game-bridge tool fails with `game_breaked` until `continue`.

## Editor collaboration (collab)

These keep a watching human oriented, and recover a session from a modal dialog.

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_editor_select` | editor | Scene-dock selection: `set`, `add`, `clear`. |
| `gd_editor_inspect` | editor | Focuses a node or resource in the inspector. |
| `gd_editor_open_script` | editor | Opens a script at a line and column and switches to the Script screen. |
| `gd_editor_set_main_screen` | editor | Switches to 2D, 3D, Script, Game, or AssetLib. |
| `gd_editor_list_dialogs` | editor | Visible dialogs with titles, text, and button labels. |
| `gd_editor_dialog_choose` | editor | Presses a named button on a visible dialog. A choice may discard unsaved work. |
| `gd_editor_ui` | editor | Tier-2 control-tree access: `find`, `describe`, `click`, `set_text`, `set_toggle`, `select_item`. Fragile across editor versions. |
| `gd_editor_screenshot` | editor | The editor window as an image block. `not_available_headless` under a headless display server. |
| `gd_editor_get_logs` | editor | Editor log output since the last call. Its own cursor, separate from `gd_editor_get_errors`. |
| `gd_editor_get_errors` | editor | New editor error and warning lines since the last call. Where a soft engine failure explains itself: the call reports success and the reason is printed here. `log_unavailable` if the editor was not launched with a log file. |

## Reflection (classdb)

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_classdb` | editor | Engine class reflection: `list_classes`, `class_info`, `properties`, `methods`, `signals`, `constants`, `enums`, `parents`, `exists`. `methods` reports `static` per method, which is what tells you whether `class:<Class>` can call it. Always routed to the editor, even for questions about the game. |

Use this instead of recalling an API from memory. It answers from the exact engine build in use.

## Object handles (object)

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_object` | game | Handles on live objects in the running game: `create`, `list`, `release`, `release_all`. |
| `gd_scene_object` | editor | The same, in the editor process. Handles are per bridge, so a game handle is meaningless here and the tool name says which one you hold. |

A handle names an object nothing else can: `SurfaceTool`, `RegEx`, a physics
query-parameter object, a space state, an unsaved resource. Two ways to get
one: `create` builds a `RefCounted` class by name, and `capture: true` on
`gd_node_call`, `gd_node_get_property`, `gd_scene_node_call`,
`gd_scene_node_get_property`, `gd_resource_call`, or
`gd_resource_get_property` takes one on the value that came back.

Spend it two ways: as `target: "object:3"` on those same verbs -- and on
`gd_signal` and `gd_scene_signal`, which is how you await a signal on an object
no path names -- or as `{"__type": "Object", "handle": "object:3"}` in an `args`
array or a property value. Only the top-level returned value is captured;
objects nested inside a returned array or dictionary are not.

`create` refuses a Node (use `gd_tree_mutate add_node` or `gd_node_add`) and
refuses a non-`RefCounted` class, because a handle could not own it. Those are
the classes you capture rather than construct. A handle lives until it is
released or the process exits; 64 per bridge, and minting past that is refused
rather than silently evicting one you still hold. A handle to a manually
managed object that something else freed reports `object_not_found` on use and
`valid: false` in `list`.

## Static calls and RIDs

`target: "class:FileAccess"` on `gd_node_call` or `gd_scene_node_call` calls a
**static** method, where there is no instance to name. This is how you open a
file or a directory: `FileAccess.open` and `DirAccess.open` are static, so no
handle could exist before you call them.

```
gd_node_call target="class:FileAccess" method="open"
             args=["user://save.dat", 2] capture=true
  -> handle "object:4", then store_string / close on that handle
```

`2` is `FileAccess.WRITE`; `1` is `READ`. The same door reaches
`Image.load_from_file`, `AudioStreamOggVorbis.load_from_file`,
`AudioStreamMP3.load_from_file`, and `JSON.stringify`. Use
`gd_classdb methods` to check `static` before guessing: naming an instance
method through `class:` is refused, with a message saying to get an instance
first.

Only the two call tools accept a `class:` target. Everything else that takes
`target` wants an object, and refuses a class by pointing you at `gd_classdb`.

A server handle (`RID`) is a value, not a target. It arrives and is spent as
`{"__type": "RID", "id": "458912960610304"}` -- the id is a decimal **string**,
because an RID is 64-bit and a JSON number would lose precision. Pass it back
verbatim in an `args` array:

```
gd_node_call target="singleton:PhysicsServer2D" method="space_create"
  -> {"__type":"RID","id":"459467011391488"}
gd_node_call target="singleton:PhysicsServer2D" method="space_set_active"
             args=[{"__type":"RID","id":"459467011391488"}, true]
```

This is what makes `PhysicsServer2D/3D`, `NavigationServer2D/3D`, and a captured
`RenderingDevice` drivable generically. A wrong-typed argument to any dynamic
call now reports `invalid_args` naming the parameter and both types, rather than
an internal error.

## Evaluation (eval)

| Tool | Bridge | Availability |
| --- | --- | --- |
| `gd_game_eval` | game | On by default; dropped by `--disable-eval`. Arbitrary GDScript in the running game, with `await` support. |
| `gd_editor_eval` | editor | Flag: `--enable-editor-eval`. Arbitrary GDScript in the editor process, with the editor's authority over the project. |

## Pixel fallback (pixel)

Flag: `--enable-pixel-tools`. Tier 3, last resort, fragile to resolution, theme, and editor
layout. Prefer a semantic tool, then `gd_editor_ui`.

| Tool | Bridge | What it does |
| --- | --- | --- |
| `gd_editor_window_info` | editor | Editor window geometry and scale, so coordinates are computed rather than guessed. |
| `gd_editor_pixel_move` | editor | Moves the synthetic cursor to an editor-window coordinate. |
| `gd_editor_pixel_click` | editor | Presses and releases a button at a coordinate. |
| `gd_editor_pixel_drag` | editor | Drags between coordinates with interpolated motion. |

## Project-defined tools

A project can teach the agent its own verbs. Any node in the `conduit_tools` group has its
public methods enumerated by the bridge and registered as MCP tools named `gd_project_` plus
the method name, with schemas derived from the GDScript type hints. A method named
`spawn_wave` becomes a tool that takes its declared arguments.

These appear when a game connects and disappear when it exits, so the tool list changes around
`gd_play` and `gd_stop`. Underscore-prefixed methods are never exposed. They execute project
code, so they are eval-class and `--disable-eval` drops the whole mechanism.

Writing one is often cheaper than replaying a setup: see recipe 8 in `recipes.md`.
