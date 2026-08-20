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
    "gd_resource_get_property",
    "Read one property of a resource file (op: get), or list the property names it has (op: list). The counterpart of gd_resource_set_property, which could previously only be written blind.",
    {
      path: z.string().describe("res:// path to the resource."),
      op: z.enum(["get", "list"]).describe("get reads one property; list enumerates the property names (default get).").optional(),
      property: z.string().describe("Property name to read (op get).").optional(),
      capture: z.boolean().describe("op get: take an object handle on the value, if it is an object, and report it as handle. Reaches sub-resources and other objects no res:// path names.").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_resource_call",
    "Call a method on a resource file and return its result, re-saving the resource afterwards unless save is false. This is what reaches Curve.add_point, Gradient.add_point, MeshLibrary.create_item, and the rest of the Resource method surface. Not undo-wrapped, matching gd_resource_set_property.",
    {
      path: z.string().describe("res:// path to the resource."),
      method: z.string().describe("Method name to call."),
      args: z.array(z.any()).describe("Positional arguments; plain JSON or tagged Godot types. An object handle is {\"__type\":\"Object\",\"handle\":\"object:3\"}.").optional(),
      save: z.boolean().describe("Re-save the resource after the call (default true). Pass false for a pure query to skip the write and the filesystem rescan.").optional(),
      capture: z.boolean().describe("Take an object handle on the returned value, if it is an object, and report it as handle. Reaches objects handed out by a resource, such as a TileSetAtlasSource.").optional(),
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
