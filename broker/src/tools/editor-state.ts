// Undo/redo and editor-state tools (whitepaper sections 6.5 and 8).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeEditorTool } from "../tool-helpers.ts";

export function registerEditorStateTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_undo",
    "Revert the most recent undo-wrapped edit-time action in the edited scene's history. Reports performed:false if there is nothing to undo.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_redo",
    "Reapply the most recently undone edit-time action. Reports performed:false if there is nothing to redo.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_get_state",
    "Report editor state: open scenes with their dirty flags, the current scene, the current selection, and whether a game is playing.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
}
