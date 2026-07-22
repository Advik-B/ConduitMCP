// gd_window: root window geometry and mode, display server identity, OS and
// platform info, and runtime locale (whitepaper section 8 "System and
// window", phase 8). Window setters are accepted no-ops under the headless
// DisplayServer; set echoes the resulting state so the agent sees what stuck.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeGameTool } from "../tool-helpers.ts";

export function registerGameWindowTools(server: McpServer, manager: BridgeManager): void {
  const gameTool = makeGameTool(server, manager);

  gameTool(
    "gd_window",
    "Window and system control selected by op: get_info (window size, position, mode, title, display server, headless flag), set (size, position, title, mode: windowed, minimized, maximized, fullscreen, exclusive_fullscreen), os_info (OS, version, processor, locale), locale_get, and locale_set.",
    {
      op: z
        .enum(["get_info", "set", "os_info", "locale_get", "locale_set"])
        .describe("Which window or system operation to perform."),
      size: z.any().describe("Window size {x,y} in pixels (set).").optional(),
      position: z.any().describe("Window position {x,y} on screen (set).").optional(),
      title: z.string().describe("Window title (set).").optional(),
      mode: z.string().describe("Window mode name (set).").optional(),
      locale: z.string().describe("Locale code, for example en or fr (locale_set).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
