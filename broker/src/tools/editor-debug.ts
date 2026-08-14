// Interactive debugging tool (whitepaper sections 6.9 and 8). The single
// gd_debug tool consolidates breakpoints, execution control, and stack and
// variable inspection behind an op discriminator, routed to the editor bridge
// which owns the EditorDebuggerPlugin.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorDebugTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_debug",
    "Interactive debugging, selected by op. set_breakpoint/clear_breakpoint/list_breakpoints manage breakpoints (1-based lines); break/continue/step_over/step_into control execution; stack and vars read the call stack and a frame's variables while halted. Breakpoints can be set before the game runs; other ops need a game launched with gd_play. While halted, game tools report game_breaked.",
    {
      op: z
        .enum([
          "set_breakpoint",
          "clear_breakpoint",
          "list_breakpoints",
          "break",
          "continue",
          "step_over",
          "step_into",
          "stack",
          "vars",
        ])
        .describe("Which debugging operation to perform."),
      path: z.string().describe("Script res:// path (set_breakpoint, clear_breakpoint).").optional(),
      line: z.number().int().min(1).describe("1-based line number (set_breakpoint, clear_breakpoint).").optional(),
      all: z.boolean().describe("clear_breakpoint: remove every breakpoint.").optional(),
      frame: z.number().int().min(0).describe("vars: stack frame index (0 = innermost, the default).").optional(),
      frame_limit: z.number().int().min(1).describe("stack: maximum frames to return.").optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    "await",
  );
}
