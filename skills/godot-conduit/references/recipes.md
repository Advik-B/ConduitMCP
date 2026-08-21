# Known-good call sequences

Each recipe is an ordering that works. Deviating is fine; skipping a step marked "always" is
what produces the dead ends listed in SKILL.md.

## 1. Cold start

1. `gd_status`. If an editor is already connected, skip to whatever the task needs.
2. `gd_addon_status` if `gd_status` reported the addon as `missing` or `stale`.
3. `gd_addon_install` if needed. Refused while an editor is connected, so `gd_editor_quit`
   first if one is up.
4. `gd_editor_launch`, *only* if no editor is running at all. It refuses with
   `editor_running_unbridged` when it finds a Godot the broker did not start, which usually means
   the human has the project open without the opt-in: say so rather than forcing past it. When it
   does launch, it takes up to a minute on a cold project, because Godot imports before extensions
   settle.
5. `gd_scene_open` for the scene the task is about, then `gd_scene_tree_get` to see it.

## 2. Build a scene

1. `gd_scene_create` with `root_type` and a `res://` path. It opens the new scene by default.
2. `gd_classdb` with `op=properties` if unsure what a node class exposes. Cheaper than a failed
   write.
3. `gd_node_add` per node, passing `properties` in the same call rather than following up with
   separate writes. Parent paths are relative to the scene root, `.` being the root.
4. `gd_scene_instantiate` to nest an existing scene rather than rebuilding it.
5. `gd_scene_save`.

Each add is one undo entry, so `gd_undo` walks the build backwards node by node.

## 3. Write and attach a script

1. `gd_script_create` with `template_source`, or with `extends` for a stub.
2. `gd_script_validate`. Always, before attaching: create does not compile-check, and a broken
   script attached to a node fails at play time instead of here.
3. `gd_script_attach` to the node.
4. `gd_editor_open_script` at the interesting line, if a human is watching.

## 4. Run and observe

1. `gd_scene_save_all`. Always: `gd_play` runs what is on disk.
2. `gd_play`. Check `game_bridge_connected` in the result. If it is false, the game launched
   without the opt-in and no game tool will work.
3. `gd_find_nodes` with a class or group filter to learn the absolute runtime paths. They start
   at `/root` and differ from the edit-time paths.
4. `gd_input` to drive it. A press without a release is a hold; release explicitly.
5. `gd_wait_frames` rather than `gd_wait_time` when the next assertion depends on it.
6. `gd_screenshot` with a `max_dimension`, or `gd_node_get_property` and `gd_perf` when
   headless makes pixels unavailable.
7. `gd_get_errors` before concluding anything worked. Its edit-time counterpart is
   `gd_editor_get_errors`: an engine error raised by an edit-time call is printed rather than
   raised, so the call reports success and only that tool carries the reason.
8. `gd_stop`.

## 5. Debug at a breakpoint

1. `gd_debug` with `op=set_breakpoint`, a script path, and a 1-based line. Works before the
   game runs.
2. `gd_scene_save_all`, then `gd_play`.
3. `gd_input` to reproduce, until the session breaks.
4. `gd_debug` with `op=stack`, then `op=vars` with a `frame` index. Frame 0 is innermost.
5. `op=step_over` or `op=step_into` to confirm the assignment site.
6. `op=continue`. Until this lands, every game-bridge tool returns `game_breaked`.
7. `gd_stop`, then fix the cause at edit time.

## 6. Tune a value, then persist it

1. With the game running, `gd_node_set_property` on the live node. Cheap, immediate, reversible
   by writing again.
2. `gd_wait_frames`, then `gd_screenshot` or a property read to judge the result. Iterate.
3. `gd_stop`.
4. `gd_scene_node_set_property` with the chosen value, on the edit-time path this time.
5. `gd_scene_save`.

Step 4 is not optional. Runtime writes vanish when the game exits.

## 7. Bring in an asset

1. `gd_asset_add` with a `res://` path and base64 bytes. It waits for the import to settle and
   returns the imported type and `uid://`.
2. `gd_scene_node_set_property` referencing it as
   `{"__type": "Resource", "path": "res://art/player.png"}`.
3. `gd_scene_save`.

Use `gd_file_move` rather than a raw file operation when relocating it later: it carries the
`.uid` sidecar so existing references survive.

## 8. Teach the project a verb

Worth doing as soon as the same multi-call setup is replayed a third time.

1. `gd_script_create` a script whose public methods are the verbs, with typed arguments so the
   generated schema is useful:

   ```gdscript
   extends Node

   func spawn_wave(kind: String, count: int = 3) -> int:
       # build the state the agent keeps recreating by hand
       return count
   ```

2. `gd_script_attach` it to a node in the scene, and `gd_node_group` with `op=add` and
   `group=conduit_tools`.
3. `gd_scene_save`, then `gd_play`.
4. The method now exists as an MCP tool named `gd_project_` plus the method name. Underscore-
   prefixed methods are never exposed, and the tools disappear when the game exits.

`example-project/phase9_tools.gd` in the Conduit repository is a working example.

## 9. Export a build

1. `gd_export_presets` to see what the project defines. An empty list means the human has to
   create one in the editor first.
2. `gd_export_project` with the preset name, an output path, and a `mode`. Use `pack` unless a
   runnable build is needed: `debug` and `release` require matching export templates to be
   installed.

Allow up to ten minutes; the export re-imports the whole project in a subprocess before packing.
