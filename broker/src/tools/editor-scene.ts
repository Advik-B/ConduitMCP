// Scene-structure tools (whitepaper section 8 "Scene structure"): open,
// create, read, save, and the node operations. Every node mutation is
// undo-wrapped bridge-side through EditorUndoRedoManager.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../bridge-manager.ts";
import { AWAIT_TIMEOUT_MS, makeEditorTool } from "../tool-helpers.ts";

export function registerEditorSceneTools(server: McpServer, manager: BridgeManager): void {
  const editorTool = makeEditorTool(server, manager);

  editorTool(
    "gd_scene_open",
    "Open a scene for editing by its res:// path, becoming the active tab.",
    { path: z.string().describe("res:// path to the scene to open.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_scene_create",
    "Create a new scene with the given root node type, saved to a res:// path. Overwrites an existing file at that path.",
    {
      root_type: z.string().describe("Engine class name for the root node, for example Node2D."),
      path: z.string().describe("res:// path to save the new scene to."),
      root_name: z.string().describe("Name for the root node; defaults to root_type.").optional(),
      open: z.boolean().describe("Open the new scene for editing after creating it (default true).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  editorTool(
    "gd_scene_tree_get",
    "Read the tree of the currently edited scene as JSON, depth-limited so a large scene does not flood context. Each node reports its attached script path, if any.",
    {
      root_path: z.string().describe("Path relative to the edited scene root to start from; defaults to the root itself.").optional(),
      max_depth: z.number().int().min(0).describe("Maximum tree depth to include (default 3).").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_scene_save",
    "Save the active scene, or a specific open scene by path (saved as a new path with save-as semantics).",
    { path: z.string().describe("res:// path to save as; omit to save the active scene in place.").optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_scene_save_all",
    "Save every open scene.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_node_add",
    "Add a node of the given engine class as a child of an existing node in the edited scene, undo-wrapped. The new node's owner is set so it persists on save.",
    {
      parent_path: z.string().describe("Path to the parent, relative to the edited scene root ('.' for the root itself)."),
      type: z.string().describe("Engine class name to instantiate, for example Sprite2D."),
      name: z.string().describe("Name for the new node; defaults to the class name.").optional(),
      properties: z
        .record(z.string(), z.any())
        .describe("Initial property values applied before the add commits; plain JSON or tagged Godot types.")
        .optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_scene_instantiate",
    "Instantiate another scene (.tscn) as a child of a node in the edited scene, undo-wrapped. The instance root is owned by the edited scene so the reference persists on save; its internal nodes stay owned by their own scene.",
    {
      scene_path: z.string().describe("res:// path of the scene to instantiate."),
      parent_path: z.string().describe("Path to the parent, relative to the edited scene root ('.' for the root itself)."),
      name: z.string().describe("Name for the instance root; defaults to the scene's root name.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_scene_node_get_property",
    "Read one property of a node in the edited scene, returned as plain JSON or a tagged Godot type. The edit-time counterpart of gd_node_get_property.",
    {
      node_path: z.string().describe("Path to the node, relative to the edited scene root ('.' for the root itself)."),
      property: z.string().describe("Property name to read."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_scene_node_set_property",
    "Set one property of a node in the edited scene, undo-wrapped, returning the previous value. Values may be plain JSON or tagged Godot types, including {__type: 'Resource', path: 'res://...'} for resource-valued properties like textures and shapes.",
    {
      node_path: z.string().describe("Path to the node, relative to the edited scene root ('.' for the root itself)."),
      property: z.string().describe("Property name to write."),
      value: z.any().describe("New value; plain JSON or a tagged Godot type."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_scene_find_nodes",
    "Find nodes in the edited scene by engine class, group membership, or name glob (* and ?). At least one filter is required; results paginate via limit/offset and report scene-relative paths.",
    {
      class: z.string().describe("Match nodes of this engine class (inheritance-aware).").optional(),
      group: z.string().describe("Match nodes in this group.").optional(),
      name_pattern: z.string().describe("Match node names against this glob, for example Enemy*.").optional(),
      root_path: z.string().describe("Subtree to search, relative to the edited scene root; defaults to the whole scene.").optional(),
      limit: z.number().int().min(1).describe("Page size (default 50).").optional(),
      offset: z.number().int().min(0).describe("Start offset from a previous next_offset.").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  editorTool(
    "gd_node_remove",
    "Remove a node from the edited scene, undo-wrapped.",
    { node_path: z.string().describe("Path to the node, relative to the edited scene root.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_node_reparent",
    "Move a node to a new parent within the edited scene, undo-wrapped. Global transform is preserved.",
    {
      node_path: z.string().describe("Path to the node, relative to the edited scene root."),
      new_parent_path: z.string().describe("Path to the new parent, relative to the edited scene root."),
      new_name: z.string().describe("Rename the node as part of the same action.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_node_rename",
    "Rename a node in the edited scene, undo-wrapped.",
    {
      node_path: z.string().describe("Path to the node, relative to the edited scene root."),
      new_name: z.string().describe("New name for the node."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  editorTool(
    "gd_node_duplicate",
    "Duplicate a node and its subtree as a sibling in the edited scene, undo-wrapped. Owners are set recursively so the copy persists on save.",
    {
      node_path: z.string().describe("Path to the node to duplicate, relative to the edited scene root."),
      new_name: z.string().describe("Name for the duplicate; defaults to the engine's own duplicate naming.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );
}
