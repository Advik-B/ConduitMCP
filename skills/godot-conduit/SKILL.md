---
name: godot-conduit
description: >-
  Drive the Godot editor and a running Godot game through the Conduit MCP server (the gd_
  tools). Use this skill whenever a task touches a Godot project and gd_ tools are available,
  even when the user does not name Conduit or MCP: editing scenes, adding or reparenting
  nodes, writing and attaching GDScript, running the game, simulating input, capturing
  screenshots, setting breakpoints, or inspecting a live scene tree. It resolves which of the
  two bridges each tool routes to, node-path conventions, tagged Variant values, error-code
  recovery, and the ordering rules that otherwise waste calls on dead ends.
---

# Driving Godot through Conduit

Conduit is one MCP surface over two separate bridges: a Godot **editor** and a **running
game**. Most wasted calls come from sending a tool to the wrong one, or from an ordering rule
that makes a call impossible. Both are settled below. Read this before the first call.

## Orient in one call

`gd_status` answers everything needed to start: whether an editor is connected and its engine
version, which game instances are connected, the resolved engine binary, and the addon state
(`missing`, `current`, `stale`, `unmanaged`). Read it once. Do not warm up with `gd_ping` or
`gd_game_list` first; they are diagnostics for when `gd_status` says something is wrong.

If the addon is `missing` or `stale`, editor tools will not work until it is installed and the
editor has been restarted. See the install rule below.

## Two bridges, one namespace

Edit-time tools change files through the editor and are undo-wrapped. Runtime tools change a
live game and are not. Neither reaches the other: an edit-time write does not affect a running
game, and a runtime write does not persist.

| Job | Edit time (editor) | Runtime (game) |
| --- | --- | --- |
| Read the tree | `gd_scene_tree_get` | `gd_tree_get` |
| Find nodes | `gd_scene_find_nodes` | `gd_find_nodes` |
| Read a property | `gd_scene_node_get_property` | `gd_node_get_property` |
| Write a property | `gd_scene_node_set_property` | `gd_node_set_property` |
| Change structure | `gd_node_add`, `gd_node_remove`, `gd_node_rename`, `gd_node_reparent`, `gd_node_duplicate`, `gd_scene_instantiate` | `gd_tree_mutate` (ops `add_node`, `instantiate`, `free`, `reparent`, `change_scene`) |
| Call a method | no equivalent; use a property or a script | `gd_node_call` |
| Signals | `gd_scene_signal` (persisted, saves with the scene) | `gd_signal` (live connect, emit, await) |
| Groups | `gd_node_group` (persisted) | `gd_find_nodes` with `group` |

Two traps in that table:

- The bare `gd_node_` prefix splits across both bridges. Structure tools (`gd_node_add` and
  family) are **edit time**; property and call tools (`gd_node_set_property`, `gd_node_call`)
  are **runtime**. The name does not tell you; this table does.
- `gd_classdb` always routes to the editor bridge, even when the question is about the running
  game. Reflection needs a connected editor.

## Node paths

Edit time: relative to the edited scene root, where `.` is the root itself. `Player/Sprite2D`.

Runtime: absolute from the tree root. `/root/Main/Player`.

Never pass one form to the other side. When unsure of a path, find it rather than guess it:
`gd_scene_find_nodes` or `gd_find_nodes` with a `class`, `group`, or `name_pattern` filter.

## Values

Godot types are tagged JSON with a `__type` discriminator:

```json
{"node_path": "Player", "property": "position", "value": {"__type": "Vector2", "x": 100, "y": 240}}
```

Accepted: `Vector2`, `Vector2i`, `Vector3`, `Vector3i`, `Vector4`, `Color`, `Quaternion`,
`Basis`, `Plane`, `Projection`, `Transform2D`, `Transform3D`, `AABB`, `Rect2`, `Rect2i`, and
the `Packed*Array` types, which serialise as plain JSON arrays of their element type.

Resource-valued properties (textures, shapes, meshes, materials) take
`{"__type": "Resource", "path": "res://art/player.png"}`. The bridge loads the path; it is
confined to `res://` and `user://`.

Plain JSON is coerced when the target property's type is known, so `{"x": 100, "y": 240}` often
works. The tagged form is always unambiguous. Reads come back tagged.

## Error code, then next call

Errors carry a stable `code`, a message that usually names the fix, and a `retryable` flag.

| Code | What to do |
| --- | --- |
| `editor_unavailable`, `disconnected` | No editor bridge. Launching is not automatically the fix: see `editor_running_unbridged` and `editor_busy` below, then `gd_editor_launch`, or ask the human to open the project. |
| `editor_busy` | The bridge accepted the connection and sent no handshake, which means it is already serving another broker: a bridge serves one client at a time. Launching an editor will not help and neither will retrying. Tell the human they have two MCP server entries for this project, commonly the Conduit plugin plus a hand-written `.mcp.json` entry, and that removing one fixes it. |
| `game_not_running` | `gd_play`. |
| `game_breaked` | A game is halted at a breakpoint. This is one global flag, so *every* game tool fails until `gd_debug` with `op=continue`. |
| `no_edited_scene` | Nothing open in the editor. `gd_scene_open`. |
| `node_not_found` | The message names the nearest existing ancestor. Re-find the path rather than guessing again. |
| `invalid_property` | Wrong name for that class. `gd_classdb` with `op=properties`. |
| `call_failed` | The engine call itself failed; read the message, and `gd_get_errors` if a game is running. |
| `not_available_headless` | No renderer under `--headless`. Assert on state instead of pixels. |
| `editor_running` | Addon install refused while an editor is connected. `gd_editor_quit`, install, relaunch. |
| `already_connected` | An editor is already up. Use it; quit first only to deliberately relaunch. |
| `editor_running_unbridged` | A Godot is running that the broker did not start. If it is this project, it was opened without the opt-in: ask the human to relaunch it with `--conduit` or `CONDUIT_ENABLE` and the broker attaches. Only pass `force=true` if that process is a different project. |
| `godot_binary_not_found` | No engine found. An editor that is already running needs none, so rule that out first. Then ask the human to set `CONDUIT_GODOT`. |
| `protocol_mismatch`, `unknown_tool` | Addon and broker versions disagree. Close the editor, `gd_addon_install`, reopen. |
| `busy`, `timeout`, `network_error` | Transient. Retry once. |

## Ordering rules

These produce dead ends rather than error messages you can act on:

- `gd_editor_launch` is optional, never a required first step. The human may already have the
  project open. An editor started without the opt-in does not show as connected, so absence of a
  bridge is not absence of an editor; launching then puts a second editor on a project Godot
  expects to own for its session. `gd_status` orients; `gd_engine_status` is the one that looks
  for a Godot the broker did not start, and is what to call before launching or installing.
- `gd_engine_install` is for a machine with no Godot at all. An editor that is already running is
  proof there is an engine, so rule that out before downloading one.
- `gd_addon_install` is refused while an editor is connected, because Godot binds a GDExtension
  only at startup. Quit, install, relaunch.
- `gd_autoload`, `gd_input_map`, and `gd_translations` write `project.godot`. They apply to
  *subsequently launched* games, not to the running editor or a live game. `gd_editor_plugin`
  writes `project.godot` too but is the exception: enabling loads the plugin into the running
  editor at once.
- `gd_script_create` does not compile-check. Run `gd_script_validate` before `gd_script_attach`.
- Writing a shader is a resource property write (`gd_resource_set_property` on `Shader.code`); it does
  not compile-check either. Run `gd_shader_validate` after, the way you would `gd_script_validate`.
- `gd_play` runs what is on disk. `gd_scene_save` or `gd_scene_save_all` first, always.
- Project-defined tools (`gd_project_` plus a method name) exist only while a game is
  connected, and disappear when it exits. Expect the tool list to change around `gd_play`.
- `gd_tree_mutate` with `op=change_scene` is deferred: follow with `gd_wait_frames` of 2, and
  treat every absolute path from the old scene as dead. `op=free` is `queue_free`, so the node
  survives until end of frame.
- Held input is a press with no release. Release explicitly. A nonzero `joy_motion` holds the
  bound action until a `value` of `0.0`.
- Prefer `gd_wait_frames` and `gd_step_frames` over `gd_wait_time` wherever determinism matters.
- `gd_undo` reverses one edit-time mutation. Project settings, autoloads, the input map,
  resource writes, and file moves are **not** undoable.
- Under a headless editor, `gd_scene_open` may leave the scene in a background tab rather than
  making it current. Confirm with `gd_editor_get_state`.

## Timeouts

So a slow call is not misread as a hang: 10 s for ordinary calls, 120 s for the await-capable
ones (eval, waits and stepping, `gd_debug`, screenshots, asset and file writes, networking,
project tools), and 600 s for `gd_export_project`, which re-imports the project before packing.

## Staying cheap

Tree dumps default to `max_depth` 3, and list ops return a bounded page (usually 50) with
`has_more`, `next_offset`, and `total_count`. Page with `limit` and `offset` rather than
widening a query. Cap screenshots with `max_dimension`. Reach for `gd_classdb` rather than
guessing an engine API, and for a find-nodes filter rather than dumping a tree to locate one
node.

## When no tool fits

Escalate in order, and stop at the first rung that works:

1. The semantic tool. Almost everything has one; check `references/tool-map.md` before
   concluding otherwise.
2. `gd_editor_ui`, which drives the editor's own Control nodes by object. Resolution- and
   theme-independent, but fragile across Godot versions.
3. `gd_editor_pixel_click` and its siblings, coordinate-level input. Off unless the operator
   passed `--enable-pixel-tools`.

`gd_game_eval` is the escape hatch for runtime work with no tool: richer physics query shapes,
CSG, multimesh, procedural meshes, curves. It runs arbitrary GDScript, so prefer a real tool
when one exists.

A tool that is absent usually means a flag, not a bug: `--enable-editor-eval`,
`--enable-pixel-tools`, `--disable-eval`, or `--tool-groups` slimming the surface. Say which
flag the human needs rather than working around it.

## Going deeper

- `references/tool-map.md` lists every tool, its bridge, and its tool group. Read it when
  looking for a capability that is not in the table above.
- `references/recipes.md` gives known-good call sequences for the common jobs: starting cold,
  building a scene, scripting it, running and observing, debugging at a breakpoint, tuning a
  value, importing an asset, teaching the project a verb, and exporting.
