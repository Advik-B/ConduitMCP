// Asset ingestion and import-settings tools (whitepaper section 8 "Assets and
// import"). The ones that touch the pipeline wait for EditorFileSystem to
// finish scanning before returning, which can take a while for larger assets.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorAssetsTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_asset_add",
    "Write agent-supplied bytes to a project path and wait for the import pipeline to settle. Returns the imported resource's type and uid://.",
    {
      path: z.string().describe("res:// path to write the asset to, for example res://textures/icon.png."),
      data_base64: z.string().describe("Base64-encoded file contents."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_asset_reimport",
    "Reimport an asset after its import settings changed, waiting for the import pipeline to settle.",
    { path: z.string().describe("res:// path to the asset to reimport.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_import_settings",
    "Read (op get) or change (op set) an asset's import options: the [params] of its .import sidecar, plus the importer and the artifact it produced. This reaches a texture's compression mode, an audio file's loop points, and a 3D scene's retargeting options without GDScript. A set reimports unless reimport is false. Not undo-wrapped, so the response reports undoable false.",
    {
      path: z.string().describe("res:// path to the asset itself, not to its .import sidecar."),
      op: z.enum(["get", "set"]).describe("get returns every import option the asset has; set writes one or more (default get).").optional(),
      params: z
        .record(z.string(), z.any())
        .describe("Import option names to new values, for example {\"compress/mode\": 1}. Required for op set. An option the asset does not already have is an error, not a silent insert; call op get first to see the names.")
        .optional(),
      reimport: z.boolean().describe("Reimport after writing (default true). Pass false to batch several writes and reimport once with gd_asset_reimport.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );
}
