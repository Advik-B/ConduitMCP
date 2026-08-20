// Project settings tools (whitepaper section 8 "Project and session"). Not
// undo-wrapped: ProjectSettings::save() persists project.godot immediately.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorProjectTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_project_get_setting",
    "Read one project setting by its project.godot key, for example application/config/name.",
    { key: z.string().describe("Project setting key.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_project_set_setting",
    "Set one project setting and save project.godot, returning the previous value. Values may be plain JSON or tagged Godot types.",
    {
      key: z.string().describe("Project setting key."),
      value: z.any().describe("New value; plain JSON or a tagged Godot type."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_autoload",
    "Autoload singletons, selected by op: list, add (name, path, enabled default true), or remove. Writes project.godot directly, not undo-wrapped; changes take effect in subsequently launched games, not the running editor.",
    {
      op: z.enum(["list", "add", "remove"]).describe("Which autoload operation to perform."),
      name: z.string().describe("Autoload name; must be a valid identifier (add/remove).").optional(),
      path: z.string().describe("res:// path of the scene or script to autoload (add).").optional(),
      enabled: z.boolean().describe("add: register enabled (default true).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_input_map",
    "Project input actions, selected by op: list, add_action (deadzone default 0.5), remove_action, add_event, remove_event (by event_index from list). Events are typed JSON: {type:'key', key|keycode, physical?, shift?...}, {type:'joy_button', button_index}, {type:'joy_motion', axis, axis_value}, {type:'mouse_button', button_index}. Writes project.godot; applies to subsequently launched games.",
    {
      op: z
        .enum(["list", "add_action", "remove_action", "add_event", "remove_event"])
        .describe("Which input-map operation to perform."),
      action: z.string().describe("Action name (all ops except list).").optional(),
      deadzone: z.number().min(0).max(1).describe("add_action: analog deadzone (default 0.5).").optional(),
      event: z.any().describe("add_event: the typed event object to bind.").optional(),
      event_index: z.number().int().min(0).describe("remove_event: index from the list op.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_plugin",
    "Editor plugins under res://addons, selected by op: list (every addons subdirectory with a plugin.cfg, its metadata and enabled state), enable, or disable. plugin is the directory name, not a path. Writes editor_plugins/enabled in project.godot, not undo-wrapped; unlike gd_autoload it takes effect in the running editor at once.",
    {
      op: z.enum(["list", "enable", "disable"]).describe("Which plugin operation to perform."),
      plugin: z.string().describe("Plugin directory name under res://addons (enable/disable).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_translations",
    "Project translations, selected by op: list (registered files, remaps, fallback and test locale), add or remove a .translation path, remap_add or remap_remove a per-locale resource variant, and set_locale (fallback, test, or both). Writes internationalization/locale/* in project.godot, not undo-wrapped. Extracting a POT template is an editor menu action with no API.",
    {
      op: z
        .enum(["list", "add", "remove", "remap_add", "remap_remove", "set_locale"])
        .describe("Which translation operation to perform."),
      path: z.string().describe("res:// path of an imported .translation resource (add/remove).").optional(),
      resource: z.string().describe("res:// path of the resource being remapped (remap_add/remap_remove).").optional(),
      variant: z.string().describe("res:// path of the localised variant (remap_add).").optional(),
      locale: z.string().describe("Locale code such as fr or pt_BR (remap_add/remap_remove).").optional(),
      fallback: z.string().describe("set_locale: locale used when the requested one is missing.").optional(),
      test: z.string().describe("set_locale: locale to preview with; empty string clears it.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
