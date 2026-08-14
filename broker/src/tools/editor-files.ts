// UID-aware file operation tools (whitepaper section 6.5). Neither is
// undo-wrapped: physical file operations are not part of the scene undo
// stack in the real editor either.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorFilesTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_file_move",
    "Move or rename a project file, carrying its .uid sidecar along so uid:// references stay valid. Does not rewrite plain res:// path references; the response reports this in a note.",
    {
      from_path: z.string().describe("Current res:// or user:// path of the file."),
      to_path: z.string().describe("New res:// or user:// path for the file."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_file_delete",
    "Delete a project file along with its .uid and .import sidecars, if present.",
    { path: z.string().describe("res:// or user:// path of the file to delete.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );
}
