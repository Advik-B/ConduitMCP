// gd_tree_mutate: live scene-tree mutation, the runtime companion of
// gd_tree_get (whitepaper section 8 "Runtime mutation", phase 8). No undo
// layer; these act on the running game directly.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeGameTool } from "../tool-helpers.ts";

export function registerGameTreeTools(server: McpServer, manager: BridgeManager): void {
  const gameTool = makeGameTool(server, manager);

  gameTool(
    "gd_tree_mutate",
    "Mutate the running scene tree, selected by op: instantiate a PackedScene under a parent, add_node (create a raw node by engine class, closing runtime setup of shapes, joints, lights, and cameras), free (queue_free; the node persists until end of frame), reparent, and change_scene (deferred; gd_wait_frames 2 to settle, old node paths die).",
    {
      op: z
        .enum(["instantiate", "add_node", "free", "reparent", "change_scene"])
        .describe("Which tree mutation to perform."),
      scene_path: z.string().describe("res:// path to a PackedScene (instantiate, change_scene).").optional(),
      class: z.string().describe("Engine node class to create (add_node).").optional(),
      parent_path: z.string().describe("Absolute path to the parent node (instantiate, add_node).").optional(),
      name: z.string().describe("Name for the new node (instantiate, add_node).").optional(),
      properties: z
        .any()
        .describe("Initial property map; tagged Variant JSON accepted (instantiate, add_node).")
        .optional(),
      node_path: z.string().describe("Absolute path to the node (free, reparent).").optional(),
      new_parent_path: z.string().describe("Absolute path to the new parent (reparent).").optional(),
      keep_global_transform: z.boolean().describe("Keep the global transform on reparent (default true).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
