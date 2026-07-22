// ClassDB introspection (whitepaper section 8 "API introspection"). The
// bridge handler is registered in both personalities; the broker routes the
// single tool to its editor connection, which is always present, since the
// reflection data is identical in both processes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeEditorTool } from "../tool-helpers.ts";

export function registerClassDbTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_classdb",
    "Engine class reflection, selected by op. list_classes enumerates class names (filter = substring); class_info returns parent, instantiability, and member counts; properties/methods/signals/constants/enums list members; parents walks the inheritance chain; exists checks a class and optionally one method/signal/property. List ops paginate via limit/offset.",
    {
      op: z
        .enum(["list_classes", "class_info", "properties", "methods", "signals", "constants", "enums", "parents", "exists"])
        .describe("Which introspection operation to perform."),
      class: z.string().describe("Class name (all ops except list_classes).").optional(),
      filter: z.string().describe("list_classes: case-insensitive substring filter.").optional(),
      no_inheritance: z.boolean().describe("Member ops: restrict to members declared on the class itself.").optional(),
      method: z.string().describe("exists: method name to check.").optional(),
      signal: z.string().describe("exists: signal name to check.").optional(),
      property: z.string().describe("exists: property name to check.").optional(),
      limit: z.number().int().min(1).describe("List ops: page size (default 100 classes, 50 members).").optional(),
      offset: z.number().int().min(0).describe("List ops: start offset from a previous next_offset.").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );
}
