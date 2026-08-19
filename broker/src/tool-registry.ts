// Tool grouping (--tool-groups, whitepaper sections 13 and 15) and the audit
// interception point, which are the same piece of machinery.
//
// Both need to see every tool registration. There is no single function every
// tool goes through: the makeEditorTool/makeGameTool factories cover most of
// them, but a dozen call server.registerTool directly, including gd_screenshot
// and gd_editor_screenshot, which are exactly the large-payload case the audit
// spec cares about. What everything does share is the McpServer, so the wrapper
// is a proxy over registerTool. That also means the 24 tools registered inline
// in index.ts need no extraction: membership is a table keyed by tool name, not
// a property of where the registration happens.

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuditLog } from "./audit.ts";

/**
 * Tool groups, following the module boundaries the tool surface already has.
 * `core` is not listed here because it cannot be disabled.
 */
export const TOOL_GROUPS = [
  "runtime",
  "tree",
  "physics",
  "render",
  "audio",
  "animation",
  "tilemap",
  "window",
  "net",
  "scene",
  "wiring",
  "script",
  "resource",
  "project",
  "state",
  "assets",
  "files",
  "export",
  "debug",
  "collab",
  "classdb",
  "eval",
  "pixel",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number] | "core";

/**
 * Which group each tool belongs to. `core` is everything needed to diagnose a
 * broker or finish setting one up, and is always registered: a deployment that
 * has slimmed away gd_status cannot be debugged, and one without
 * gd_addon_install cannot be completed.
 */
export const TOOL_GROUP_BY_NAME: Record<string, ToolGroup> = {
  // core
  gd_ping: "core",
  gd_status: "core",
  gd_game_list: "core",
  gd_get_events: "core",
  gd_project_scaffold: "core",
  gd_addon_install: "core",
  gd_addon_status: "core",
  gd_engine_status: "core",
  gd_engine_install: "core",
  gd_editor_launch: "core",
  gd_editor_quit: "core",

  // runtime: driving and observing the running game
  gd_play: "runtime",
  gd_stop: "runtime",
  gd_find_nodes: "runtime",
  gd_tree_get: "runtime",
  gd_node_get_info: "runtime",
  gd_node_get_property: "runtime",
  gd_node_set_property: "runtime",
  gd_node_call: "runtime",
  gd_signal: "runtime",
  gd_input: "runtime",
  gd_screenshot: "runtime",
  gd_perf: "runtime",
  gd_get_logs: "runtime",
  gd_get_errors: "runtime",
  gd_pause: "runtime",
  gd_step_frames: "runtime",
  gd_wait_time: "runtime",
  gd_wait_frames: "runtime",
  gd_set_time_scale: "runtime",

  gd_tree_mutate: "tree",
  gd_physics: "physics",
  gd_render: "render",
  gd_audio: "audio",
  gd_animation: "animation",
  gd_tilemap: "tilemap",
  gd_window: "window",

  gd_http_request: "net",
  gd_websocket: "net",
  gd_multiplayer: "net",

  gd_classdb: "classdb",

  // edit-time
  gd_scene_open: "scene",
  gd_scene_create: "scene",
  gd_scene_tree_get: "scene",
  gd_scene_save: "scene",
  gd_scene_save_all: "scene",
  gd_scene_instantiate: "scene",
  gd_scene_node_get_property: "scene",
  gd_scene_node_set_property: "scene",
  gd_scene_node_call: "scene",
  gd_scene_find_nodes: "scene",
  gd_node_add: "scene",
  gd_node_remove: "scene",
  gd_node_rename: "scene",
  gd_node_reparent: "scene",
  gd_node_duplicate: "scene",

  gd_scene_signal: "wiring",
  gd_node_group: "wiring",

  gd_script_create: "script",
  gd_script_attach: "script",
  gd_script_detach: "script",
  gd_script_validate: "script",

  gd_resource_create: "resource",
  gd_resource_set_property: "resource",
  gd_resource_get_property: "resource",
  gd_resource_call: "resource",

  gd_project_get_setting: "project",
  gd_project_set_setting: "project",
  gd_autoload: "project",
  gd_input_map: "project",

  gd_undo: "state",
  gd_redo: "state",
  gd_editor_get_state: "state",

  gd_asset_add: "assets",
  gd_asset_reimport: "assets",
  gd_import_settings: "assets",

  gd_file_move: "files",
  gd_file_delete: "files",

  gd_export_presets: "export",
  gd_export_project: "export",

  gd_debug: "debug",

  gd_editor_select: "collab",
  gd_editor_open_script: "collab",
  gd_editor_inspect: "collab",
  gd_editor_set_main_screen: "collab",
  gd_editor_list_dialogs: "collab",
  gd_editor_dialog_choose: "collab",
  gd_editor_ui: "collab",
  gd_editor_screenshot: "collab",

  gd_game_eval: "eval",
  gd_editor_eval: "eval",

  gd_editor_pixel_click: "pixel",
  gd_editor_pixel_drag: "pixel",
  gd_editor_pixel_move: "pixel",
  gd_editor_window_info: "pixel",
};

export class ToolGroupError extends Error {}

/**
 * Which groups survive a `--tool-groups` value.
 *
 * `scene,runtime` is an allowlist; `-net,-audio` subtracts from the full set,
 * which is the "dropping networking and audio" case section 13 describes.
 * Mixing the two would be ambiguous, so it is rejected rather than guessed at.
 */
export function parseToolGroups(spec: string | null): Set<ToolGroup> | null {
  if (spec === null || spec.trim() === "") {
    return null;
  }
  const entries = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return null;
  }
  const valid = new Set<string>(TOOL_GROUPS);
  const subtractive = entries.filter((entry) => entry.startsWith("-"));
  if (subtractive.length > 0 && subtractive.length !== entries.length) {
    throw new ToolGroupError(
      `--tool-groups mixes kept and dropped groups; use either a list to keep (scene,runtime) or a list to drop (-net,-audio). Valid groups: ${[...valid].join(", ")}`,
    );
  }
  const names = entries.map((entry) => (entry.startsWith("-") ? entry.slice(1) : entry));
  for (const name of names) {
    if (name === "core") {
      throw new ToolGroupError("the core group is always registered and cannot be selected or dropped");
    }
    if (!valid.has(name)) {
      throw new ToolGroupError(`unknown tool group "${name}". Valid groups: ${[...valid].join(", ")}`);
    }
  }
  const selected =
    subtractive.length > 0
      ? new Set<ToolGroup>(TOOL_GROUPS.filter((group) => !names.includes(group)))
      : new Set<ToolGroup>(names as ToolGroup[]);
  selected.add("core");
  return selected;
}

export interface WrapOptions {
  audit?: AuditLog | null;
  /** null keeps every group; otherwise only these are registered. */
  groups?: Set<ToolGroup> | null;
}

// Returned in place of a RegisteredTool for a filtered-out tool. Only
// ProjectToolsRegistry reads that value, and dynamic gd_project_* names are
// never in the group table (see below), so this is never handed out to it.
function stubRegistration(): RegisteredTool {
  return {
    remove: () => {},
    enable: () => {},
    disable: () => {},
    update: () => {},
  } as unknown as RegisteredTool;
}

/**
 * Wrap an McpServer so every tool registration passes through group filtering
 * and audit timing. Applied once, in main(), and handed to every registration
 * path in place of the real server.
 *
 * Names absent from the table are passed through unfiltered but still audited.
 * That is the dynamic `gd_project_*` surface, whose names come from project code
 * at runtime and cannot be in a static table; it is already gated as a whole by
 * --disable-eval.
 */
export function wrapServer(server: McpServer, options: WrapOptions): McpServer {
  const { audit = null, groups = null } = options;
  if (!audit && !groups) {
    return server;
  }
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
        const group = TOOL_GROUP_BY_NAME[name];
        if (groups && group && !groups.has(group)) {
          return stubRegistration();
        }
        const wrapped = audit
          ? async (...args: unknown[]) => {
              const started = performance.now();
              try {
                const result = await callback(...args);
                audit.record(name, args[0], result, performance.now() - started);
                return result;
              } catch (error) {
                // Handlers return errors rather than throwing, so this is the
                // unexpected path: a schema rejection from the SDK, or a bug
                // escaping a handler's own catch. Those are the calls most
                // worth having in the log, so record before re-throwing.
                const text = `uncaught: ${error instanceof Error ? error.message : String(error)}`;
                audit.record(
                  name,
                  args[0],
                  { content: [{ type: "text", text }], isError: true },
                  performance.now() - started,
                );
                throw error;
              }
            }
          : callback;
        return (target.registerTool as unknown as (n: string, c: unknown, cb: unknown) => RegisteredTool)(
          name,
          config,
          wrapped,
        );
      };
    },
  });
}
