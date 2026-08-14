// gd_render: cameras, world environment, viewport render settings, and debug
// draw (whitepaper section 8 "Rendering and environment", phase 8). Lights
// and camera attributes are plain node and resource properties, covered by
// the generic property tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeGameTool } from "../tool-helpers.ts";

export function registerGameRenderTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const gameTool = makeGameTool(server, manager, timeouts);

  gameTool(
    "gd_render",
    "Rendering control selected by op: camera_get and camera_set (dimension 2d or 3d, property map plus make_current), environment_get and environment_set (world environment or a WorldEnvironment node), viewport_get and viewport_set (msaa, screen-space AA, debanding, 3D scaling), debug_draw (line, circle, rect, sphere, box with optional duration), and debug_clear.",
    {
      op: z
        .enum([
          "camera_get",
          "camera_set",
          "environment_get",
          "environment_set",
          "viewport_get",
          "viewport_set",
          "debug_draw",
          "debug_clear",
        ])
        .describe("Which rendering operation to perform."),
      dimension: z.enum(["2d", "3d"]).describe("Camera or debug-draw space (camera ops, debug_draw).").optional(),
      node_path: z
        .string()
        .describe("Camera node (camera_set, defaults to the current camera) or WorldEnvironment node (environment ops).")
        .optional(),
      make_current: z.boolean().describe("Make the camera current (camera_set).").optional(),
      properties: z
        .any()
        .describe("Property map to apply; tagged Variant JSON accepted (camera_set, environment_set, viewport_set).")
        .optional(),
      keys: z.array(z.string()).describe("Environment property names to read (environment_get).").optional(),
      kind: z.string().describe("Primitive kind (debug_draw): line, circle, rect (2d); line, sphere, box (3d).").optional(),
      from: z.any().describe("Line start (debug_draw).").optional(),
      to: z.any().describe("Line end (debug_draw).").optional(),
      center: z.any().describe("Circle, sphere, or box center (debug_draw).").optional(),
      radius: z.number().describe("Circle or sphere radius (debug_draw).").optional(),
      position: z.any().describe("Rect position (debug_draw).").optional(),
      size: z.any().describe("Rect or box size (debug_draw).").optional(),
      color: z.any().describe("Primitive color {r,g,b,a} (debug_draw, default white).").optional(),
      duration: z.number().describe("Seconds before the primitive expires (debug_draw, default until clear).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
