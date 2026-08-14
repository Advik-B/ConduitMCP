// Resource tools (whitepaper section 8 "Scripts and resources"). Neither is
// undo-wrapped: both are direct ResourceLoader/ResourceSaver round trips, so
// gd_undo cannot silently diverge from what is already persisted to disk.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorResourceTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_resource_create",
    "Create a resource of the given engine class, saved to a res:// path. Overwrites an existing file at that path. Returns the resource's type and uid://.",
    {
      class_name: z.string().describe("Engine Resource subclass to instantiate, for example Resource or AudioStreamWAV."),
      path: z.string().describe("res:// path to save the new resource to."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_resource_set_property",
    "Set one property of a resource file and re-save it, returning the previous value. Values may be plain JSON or tagged Godot types.",
    {
      path: z.string().describe("res:// path to the resource."),
      property: z.string().describe("Property name to write."),
      value: z.any().describe("New value; plain JSON or a tagged Godot type."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );
}
