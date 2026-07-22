// Persisted signal connections and persistent node groups on the edited
// scene (whitepaper section 8 "Scene structure"). Both are undo-wrapped
// bridge-side; connections always carry CONNECT_PERSIST so they serialize
// on save.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { makeEditorTool } from "../tool-helpers.ts";

export function registerEditorWiringTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_scene_signal",
    "Persisted signal connections in the edited scene, selected by op. connect wires node_path.signal to target_path.method (CONNECT_PERSIST, undo-wrapped; the target method may not exist yet); disconnect severs a persisted connection; list reports a node's persisted connections, optionally filtered by signal.",
    {
      op: z.enum(["connect", "disconnect", "list"]).describe("Which signal operation to perform."),
      node_path: z.string().describe("Source node path, relative to the edited scene root."),
      signal: z.string().describe("Signal name (required for connect/disconnect; filters list).").optional(),
      target_path: z.string().describe("Target node path, relative to the edited scene root (connect/disconnect).").optional(),
      method: z.string().describe("Target method name (connect/disconnect).").optional(),
      deferred: z.boolean().describe("connect: use CONNECT_DEFERRED in addition to CONNECT_PERSIST.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_node_group",
    "Persistent node groups in the edited scene, selected by op. add and remove are undo-wrapped and persist on save; list reports a node's groups, filtering internal underscore-prefixed groups unless include_internal is set.",
    {
      op: z.enum(["add", "remove", "list"]).describe("Which group operation to perform."),
      node_path: z.string().describe("Node path, relative to the edited scene root."),
      group: z.string().describe("Group name (required for add/remove).").optional(),
      include_internal: z.boolean().describe("list: include underscore-prefixed internal groups.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
