// Object handles: holding an engine object that has no name across tool calls
// (whitepaper section 7.3, "the target grammar").
//
// Two tools rather than one, because the handle table is per bridge process: a
// handle taken out of a running game means nothing to the editor. The split
// follows the one the generic verbs already use, so which process holds a
// handle is visible in the tool name instead of hidden in an argument.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool, makeGameTool } from "../tool-helpers.ts";

const OPS = ["create", "list", "release", "release_all"] as const;

/** The shared schema. Identical on both bridges; only the routing differs. */
function schema(createHint: string): Record<string, z.ZodTypeAny> {
  return {
    op: z.enum(OPS).describe("create takes a handle on a new object; list reports what is held; release drops one; release_all drops all."),
    class: z.string().describe(`create: engine class to instantiate. Must be RefCounted and instantiable, for example ${createHint}. A Node is refused; objects that are handed out rather than constructed are reached with capture instead.`).optional(),
    properties: z.record(z.string(), z.any()).describe("create: initial property values, applied before the handle exists.").optional(),
    handle: z.string().describe("release: the handle to drop, for example object:3.").optional(),
  };
}

const DESCRIPTION =
  "Hold an engine object that no path names, so later calls can act on it: pass the handle as target:\"object:<n>\", or as {\"__type\":\"Object\",\"handle\":\"object:<n>\"} in an argument. Reaches SurfaceTool, RegEx, query parameters, and anything captured from a call. Handles live until released or the process exits.";

export function registerObjectTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);
  const editorTool = makeEditorTool(server, manager, timeouts);

  gameTool(
    "gd_object",
    `${DESCRIPTION} Game bridge: use with gd_node_call and gd_node_get_property.`,
    schema("SurfaceTool or PhysicsRayQueryParameters3D"),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_scene_object",
    `${DESCRIPTION} Editor bridge: use with gd_scene_node_call and gd_scene_node_get_property.`,
    schema("ConfigFile or RegEx"),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );
}
