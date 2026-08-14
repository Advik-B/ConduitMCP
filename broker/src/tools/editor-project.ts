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
}
