// Signal connections and persistent node groups on the edited scene
// (whitepaper section 8 "Scene structure").
//
// A connection between two nodes of the edited scene is undo-wrapped and
// carries CONNECT_PERSIST so it serializes on save. A signal on a singleton or
// a handle-held object has no scene file to serialize into, so those ops are
// live-only and the bridge reports persisted: false, undoable: false.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { type Timeouts, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorWiringTools(server: McpServer, manager: BridgeManager, timeouts?: Timeouts): void {
  const editorTool = makeEditorTool(server, manager, timeouts);

  editorTool(
    "gd_scene_signal",
    "Signal ops on the edited scene or on any target, selected by op: connect, disconnect, emit, list, or await (await suspends until the signal fires). Node-to-node connects are CONNECT_PERSIST and undo-wrapped, so they save with the scene; a singleton or object:<n> source connects live and reports persisted: false.",
    {
      op: z.enum(["connect", "disconnect", "emit", "list", "await"]).describe("Which signal operation to perform."),
      target: z.string().describe("The emitter: node path relative to the edited scene root, or 'singleton:<Class>', or 'object:<n>' for a handle held by gd_scene_object.").optional(),
      node_path: z.string().describe("Source node path, relative to the edited scene root. Legacy alias for target; pass one or the other, not both.").optional(),
      signal: z.string().describe("Signal name (required for connect/disconnect/emit/await; filters list).").optional(),
      receiver: z.string().describe("The connection destination (connect/disconnect), in the same grammar as target.").optional(),
      target_path: z.string().describe("Destination node path, relative to the edited scene root. Legacy alias for receiver; pass one or the other, not both.").optional(),
      method: z.string().describe("Receiver method name (connect/disconnect).").optional(),
      args: z.array(z.any()).describe("Arguments to emit.").optional(),
      deferred: z.boolean().describe("connect: use CONNECT_DEFERRED as well.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    "await",
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
