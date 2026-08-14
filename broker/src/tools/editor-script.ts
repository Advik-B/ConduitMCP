// Script tools (whitepaper section 8 "Scripts and resources"). Attach/detach
// are undo-wrapped bridge-side; create and validate are not (file creation
// and a read-only diagnostic, respectively).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorScriptTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_script_create",
    "Create a GDScript file at a res:// path, either from a minimal 'extends <base>' template or literal source text. Overwrites an existing file at that path. Does not validate the source; use gd_script_validate to check it.",
    {
      path: z.string().describe("res:// path to save the script to, for example res://player.gd."),
      extends: z.string().describe("Base class for the template source (default Node); ignored if template_source is given.").optional(),
      template_source: z.string().describe("Literal GDScript source to write verbatim instead of the template.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
  );

  editorTool(
    "gd_script_attach",
    "Attach an existing script to a node in the edited scene, undo-wrapped.",
    {
      node_path: z.string().describe("Path to the node, relative to the edited scene root."),
      script_path: z.string().describe("res:// path to the script resource to attach."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_script_detach",
    "Remove the attached script from a node in the edited scene, undo-wrapped.",
    { node_path: z.string().describe("Path to the node, relative to the edited scene root.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_script_validate",
    "Reload a script through the engine and report whether it compiles, with line-numbered diagnostics on failure. Does not launch the game.",
    { path: z.string().describe("res:// path to the script to validate.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
}
