// Asset ingestion tools (whitepaper section 8 "Assets and import"). Both wait
// for EditorFileSystem to finish scanning before returning, which can take a
// while for larger assets.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { AWAIT_TIMEOUT_MS, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorAssetsTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_asset_add",
    "Write agent-supplied bytes to a project path and wait for the import pipeline to settle. Returns the imported resource's type and uid://.",
    {
      path: z.string().describe("res:// path to write the asset to, for example res://textures/icon.png."),
      data_base64: z.string().describe("Base64-encoded file contents."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  editorTool(
    "gd_asset_reimport",
    "Reimport an asset after its import settings changed, waiting for the import pipeline to settle.",
    { path: z.string().describe("res:// path to the asset to reimport.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );
}
