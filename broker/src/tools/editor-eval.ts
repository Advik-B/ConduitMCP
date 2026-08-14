// Opt-in editor-process evaluation (whitepaper sections 8 and 9). Registered
// only under --enable-editor-eval / CONDUIT_ENABLE_EDITOR_EVAL, the same
// mechanism that gates the pixel tools: it runs arbitrary GDScript with the
// editor's authority over the project.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorEvalTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_editor_eval",
    "Evaluate GDScript inside the editor process with return values and await support, for editor automation with no dedicated tool. Runs with the editor's authority and can mutate the project; enabled only by explicit opt-in.",
    {
      source: z
        .string()
        .describe("GDScript to evaluate: an expression, or statements ending in a return. await is supported."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    "await",
  );
}
