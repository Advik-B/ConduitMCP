// gd_tilemap: TileMapLayer and GridMap cell access (whitepaper section 8
// "2D and 3D systems", phase 8 scope: cells). The target kind is picked by
// the resolved node's class; the deprecated TileMap node is rejected.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeGameTool } from "../tool-helpers.ts";

export function registerGameTilemapTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);

  gameTool(
    "gd_tilemap",
    "TileMapLayer and GridMap cell access selected by op: get_cell, set_cell, erase_cell, used_cells (paginated via limit/offset with an optional region filter), used_rect, and clear. TileMapLayer cells use source_id, atlas_coords, and alternative_tile; GridMap cells use item and orientation. The node's class picks the kind.",
    {
      op: z
        .enum(["get_cell", "set_cell", "erase_cell", "used_cells", "used_rect", "clear"])
        .describe("Which cell operation to perform."),
      node_path: z.string().describe("Absolute path to a TileMapLayer or GridMap node."),
      coords: z.any().describe("Cell coordinates {x,y} (TileMapLayer) or {x,y,z} (GridMap).").optional(),
      source_id: z.number().int().describe("TileSet source id (set_cell, default 0).").optional(),
      atlas_coords: z.any().describe("Atlas tile coordinates {x,y} (set_cell, default 0,0).").optional(),
      alternative_tile: z.number().int().describe("Alternative tile id (set_cell, default 0).").optional(),
      item: z.number().int().describe("MeshLibrary item index (GridMap set_cell; -1 clears).").optional(),
      orientation: z.number().int().describe("Cell orientation index (GridMap set_cell, default 0).").optional(),
      region: z
        .any()
        .describe("Filter used_cells to a region: {x,y,w,h} (2D) or {position, size} (3D).")
        .optional(),
      limit: z.number().int().min(1).max(1024).describe("Page size for used_cells (default 256).").optional(),
      offset: z.number().int().min(0).describe("Start offset from a previous next_offset.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
