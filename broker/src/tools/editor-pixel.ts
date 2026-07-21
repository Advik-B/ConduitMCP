// Tier-3 pixel-fallback tools (whitepaper section 6.8), disabled by default and
// registered only when the operator passes --enable-pixel-tools (section 15).
// These are the last resort for editor gestures with no semantic (tier 1) or
// control-tree (tier 2) equivalent; prefer those tools wherever they exist.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeEditorTool } from "../tool-helpers.ts";

const buttonField = z
  .enum(["left", "right", "middle"])
  .describe("Mouse button (default left).")
  .optional();

const PIXEL_WARNING =
  "Tier-3 last-resort pixel input against the editor window; fragile to resolution, theme, and editor layout. Prefer semantic tools or gd_editor_ui; use gd_editor_window_info to compute coordinates.";

export function registerEditorPixelTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_editor_window_info",
    "Report the editor window geometry (size, position) and scale (editor UI scale, screen scale, DPI) so pixel coordinates for the gd_editor_pixel_* tools are computed rather than guessed.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_editor_pixel_move",
    `Move the synthetic cursor to an editor-window coordinate through the editor viewport. ${PIXEL_WARNING}`,
    {
      x: z.number().describe("Editor-window x coordinate in pixels."),
      y: z.number().describe("Editor-window y coordinate in pixels."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_pixel_click",
    `Press and release a mouse button at an editor-window coordinate. ${PIXEL_WARNING}`,
    {
      x: z.number().describe("Editor-window x coordinate in pixels."),
      y: z.number().describe("Editor-window y coordinate in pixels."),
      button: buttonField,
      double: z.boolean().describe("Send a double-click instead of a single click.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_pixel_drag",
    `Drag from one editor-window coordinate to another with a button held, emitting the press, interpolated motion, and release across frames. ${PIXEL_WARNING}`,
    {
      from_x: z.number().describe("Start x coordinate in pixels."),
      from_y: z.number().describe("Start y coordinate in pixels."),
      to_x: z.number().describe("End x coordinate in pixels."),
      to_y: z.number().describe("End y coordinate in pixels."),
      button: buttonField,
      steps: z
        .number()
        .int()
        .min(1)
        .max(256)
        .describe("Interpolated motion events between start and end (default 8).")
        .optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
