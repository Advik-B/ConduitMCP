// gd_physics: physics and navigation queries plus world settings (whitepaper
// section 8 "Physics and navigation", phase 8). Body and joint configuration
// is plain node properties, covered by gd_node_set_property and
// gd_tree_mutate add_node.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeGameTool } from "../tool-helpers.ts";

export function registerGamePhysicsTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);

  gameTool(
    "gd_physics",
    "Physics and navigation selected by op: raycast, intersect_point, intersect_shape (primitive circle/rectangle/sphere/box only; richer shapes via gd_game_eval), nav_path, nav_bake (NavigationRegion node), world_get, and world_set (gravity, gravity_vector, physics tick). dimension picks the 2d or 3d world.",
    {
      op: z
        .enum(["raycast", "intersect_point", "intersect_shape", "nav_path", "nav_bake", "world_get", "world_set"])
        .describe("Which physics or navigation operation to perform."),
      dimension: z.enum(["2d", "3d"]).describe("Which physics world to query."),
      from: z.any().describe("Ray or path start {x,y} or {x,y,z}.").optional(),
      to: z.any().describe("Ray or path end {x,y} or {x,y,z}.").optional(),
      position: z.any().describe("Query position (intersect_point, intersect_shape).").optional(),
      shape: z
        .any()
        .describe("Primitive shape (intersect_shape): {kind: circle|rectangle|sphere|box, radius or size}.")
        .optional(),
      collision_mask: z.number().int().describe("Collision mask bits (default all).").optional(),
      collide_with_areas: z.boolean().describe("Also hit Area nodes (default false).").optional(),
      hit_from_inside: z.boolean().describe("Report hits starting inside a shape (raycast).").optional(),
      max_results: z.number().int().min(1).max(256).describe("Result cap for intersections (default 8).").optional(),
      optimize: z.boolean().describe("Optimize the navigation path (nav_path, default true).").optional(),
      node_path: z.string().describe("NavigationRegion2D/3D to bake (nav_bake).").optional(),
      on_thread: z.boolean().describe("Bake on a thread (nav_bake, default false).").optional(),
      gravity: z.number().describe("Gravity magnitude (world_set).").optional(),
      gravity_vector: z.any().describe("Gravity direction vector (world_set).").optional(),
      physics_ticks_per_second: z.number().int().describe("Physics tick rate (world_set).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
