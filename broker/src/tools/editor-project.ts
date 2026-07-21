// Project settings tools (whitepaper section 8 "Project and session"). Not
// undo-wrapped: ProjectSettings::save() persists project.godot immediately.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeEditorTool } from "../tool-helpers.ts";

export function registerEditorProjectTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

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
}
