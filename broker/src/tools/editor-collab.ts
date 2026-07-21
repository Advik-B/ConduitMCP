// Editor state, collaboration, and tier-2 control-tree tools (whitepaper
// sections 6.8 and 8). These let an agent select and show nodes, navigate the
// editor, and observe and dismiss dialogs, all through objects rather than
// pixels. The screenshot tool returns an image content block like gd_screenshot.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { AWAIT_TIMEOUT_MS, makeEditorTool, toToolError } from "../tool-helpers.ts";

export function registerEditorCollabTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_editor_select",
    "Select nodes in the scene dock (op: set replaces the selection, add extends it, clear empties it). Node paths are relative to the edited scene root.",
    {
      op: z.enum(["set", "add", "clear"]).describe("How to change the selection."),
      node_paths: z.array(z.string()).describe("Edited-scene node paths (op set/add).").optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_open_script",
    "Open a script in the script editor, optionally at a line and column, and switch to the Script main screen.",
    {
      path: z.string().describe("res:// path of the script to open."),
      line: z.number().int().min(1).describe("1-based line to place the cursor on.").optional(),
      column: z.number().int().min(0).describe("Column to place the cursor on.").optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_editor_inspect",
    "Focus a node or a resource in the inspector so a human sees exactly what the agent means. Provide exactly one of node_path or resource_path.",
    {
      node_path: z.string().describe("Edited-scene node path to inspect.").optional(),
      resource_path: z.string().describe("res:// resource path to inspect.").optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_editor_set_main_screen",
    "Switch the editor's main screen to 2D, 3D, Script, Game, or AssetLib.",
    { name: z.enum(["2D", "3D", "Script", "Game", "AssetLib"]).describe("Main screen to show.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_editor_list_dialogs",
    "List the editor's currently visible dialogs with their title, text, and button labels, so a modal that would stall the session can be seen and dismissed.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_editor_dialog_choose",
    "Press a named button on a visible dialog (selected by title or index), dismissing it exactly as a click would. A choice may discard unsaved work, so it is treated as destructive.",
    {
      button: z.string().describe("Button label to press, for example 'OK' or 'Cancel' (case-insensitive)."),
      title: z.string().describe("Dialog title to target; defaults to the first visible dialog.").optional(),
      index: z.number().int().min(0).describe("Visible-dialog index, an alternative to title.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_editor_ui",
    "Tier-2 editor control-tree access when no semantic tool exists (op: find, describe, click, set_text, set_toggle, select_item). Acts on the editor's own Control nodes by object, so it is resolution- and theme-independent but fragile to editor UI refactors between Godot versions. select_item on a PopupMenu activates a menu entry without showing the popup.",
    {
      op: z.enum(["find", "describe", "click", "set_text", "set_toggle", "select_item"]).describe("Which control operation to perform."),
      path: z.string().describe("Absolute editor control path (describe, click, set_text, set_toggle, select_item).").optional(),
      pattern: z.string().describe("find: case-insensitive substring to match on the control name.").optional(),
      class: z.string().describe("find: only controls of this class (or a subclass).").optional(),
      root: z.string().describe("find: control path to search under; defaults to the editor base control.").optional(),
      limit: z.number().int().min(1).describe("find: maximum controls to return (default 50).").optional(),
      offset: z.number().int().min(0).describe("find: pagination offset.").optional(),
      text: z.string().describe("set_text: the text to write; or select_item: match an item by text.").optional(),
      submit: z.boolean().describe("set_text: also fire submission (LineEdit).").optional(),
      pressed: z.boolean().describe("set_toggle: the toggle state to set.").optional(),
      index: z.number().int().min(0).describe("select_item: item index.").optional(),
      id: z.number().int().describe("select_item: PopupMenu item id.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  server.registerTool(
    "gd_editor_screenshot",
    {
      description:
        "Capture a screenshot of the editor window after the next drawn frame, returned as an image. Reports not_available_headless under a headless display server.",
      inputSchema: {
        max_dimension: z.number().int().min(1).describe("Longest-edge pixel cap; the image is scaled to fit.").optional(),
        format: z.enum(["png", "jpg"]).describe("Image format (default png).").optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = (await manager.editorRequest("gd_editor_screenshot", args as Record<string, unknown>, AWAIT_TIMEOUT_MS)) as {
          image_base64: string;
          format: string;
        };
        const mimeType = result.format === "jpg" ? "image/jpeg" : "image/png";
        return { content: [{ type: "image", data: result.image_base64, mimeType }] };
      } catch (error) {
        return toToolError(error);
      }
    },
  );
}
