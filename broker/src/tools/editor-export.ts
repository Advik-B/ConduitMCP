// Project export (whitepaper section 8 "Assets and import", phase 10 "Headless
// and CI mode"). Drives Godot's own headless export CLI against the project's
// export_presets.cfg; see bridge/src/handlers/editor/import_export.rs for why
// this is a subprocess shell-out rather than an in-process editor API call.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { EXPORT_TIMEOUT_MS, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorExportTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_export_project",
    "Export the project headlessly through a preset from export_presets.cfg, producing a real build artifact suitable for CI. mode='pack' writes only a .pck resource pack (no export templates needed); 'debug' and 'release' produce a runnable build and require matching export templates to be installed.",
    {
      preset: z.string().describe("Preset name from export_presets.cfg, for example 'Linux (debug)'."),
      output_path: z.string().describe("Destination path (res:// or user://) for the exported artifact."),
      mode: z.enum(["pack", "debug", "release"]).describe("Export kind: pack (.pck only), debug, or release build."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    EXPORT_TIMEOUT_MS,
  );

  editorTool(
    "gd_export_presets",
    "List the project's export presets from export_presets.cfg: name, platform, runnable flag, export path, and resource filters. A project with no presets returns an empty list.",
    {
      limit: z.number().int().min(1).describe("Page size (default 50).").optional(),
      offset: z.number().int().min(0).describe("Start offset from a previous next_offset.").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
}
