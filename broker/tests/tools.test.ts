import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeManager } from "../src/bridge-manager.ts";
import type { EventRing } from "../src/events.ts";
import { registerTools } from "../src/index.ts";

interface Registration {
  name: string;
  config: {
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
}

function collectRegistrations(): { server: McpServer; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const server = {
    registerTool(name: string, config: Registration["config"]) {
      registrations.push({ name, config });
    },
  } as unknown as McpServer;
  return { server, registrations };
}

const EXPECTED_TOOLS = [
  "gd_asset_add",
  "gd_asset_reimport",
  "gd_autoload",
  "gd_classdb",
  "gd_debug",
  "gd_editor_dialog_choose",
  "gd_editor_get_state",
  "gd_editor_inspect",
  "gd_editor_list_dialogs",
  "gd_editor_open_script",
  "gd_editor_screenshot",
  "gd_editor_select",
  "gd_editor_set_main_screen",
  "gd_editor_ui",
  "gd_export_project",
  "gd_file_delete",
  "gd_file_move",
  "gd_find_nodes",
  "gd_game_eval",
  "gd_game_list",
  "gd_get_errors",
  "gd_get_events",
  "gd_get_logs",
  "gd_input",
  "gd_input_map",
  "gd_node_add",
  "gd_node_call",
  "gd_node_duplicate",
  "gd_node_get_info",
  "gd_node_get_property",
  "gd_node_group",
  "gd_node_remove",
  "gd_node_rename",
  "gd_node_reparent",
  "gd_node_set_property",
  "gd_pause",
  "gd_perf",
  "gd_ping",
  "gd_play",
  "gd_project_get_setting",
  "gd_project_set_setting",
  "gd_redo",
  "gd_resource_create",
  "gd_resource_set_property",
  "gd_scene_create",
  "gd_scene_find_nodes",
  "gd_scene_instantiate",
  "gd_scene_node_get_property",
  "gd_scene_node_set_property",
  "gd_scene_open",
  "gd_scene_save",
  "gd_scene_save_all",
  "gd_scene_signal",
  "gd_scene_tree_get",
  "gd_screenshot",
  "gd_script_attach",
  "gd_script_create",
  "gd_script_detach",
  "gd_script_validate",
  "gd_set_time_scale",
  "gd_signal",
  "gd_status",
  "gd_step_frames",
  "gd_stop",
  "gd_tree_get",
  "gd_undo",
  "gd_wait_frames",
  "gd_wait_time",
];

describe("tool definitions", () => {
  const { server, registrations } = collectRegistrations();
  // The manager and events are only used inside handlers, not during registration.
  // Pixel tools are off by default, so the default surface excludes them.
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, {
    enablePixelTools: false,
    enableEditorEval: false,
  });

  test("registers exactly the phase 1-7 tool surface", () => {
    const names = registrations.map((r) => r.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  test("the tool surface stays within the section 7.1 budget of 40-75 tools", () => {
    expect(registrations.length).toBeGreaterThanOrEqual(40);
    expect(registrations.length).toBeLessThanOrEqual(75);
  });

  test("every tool name is gd_-prefixed and unique", () => {
    const names = registrations.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith("gd_")).toBe(true);
    }
  });

  test("every tool declares a description and annotations", () => {
    for (const { config } of registrations) {
      expect(typeof config.description).toBe("string");
      expect((config.description ?? "").length).toBeGreaterThan(10);
      expect(config.annotations).toBeDefined();
    }
  });

  test("descriptions stay within a reasonable length bound", () => {
    for (const { config } of registrations) {
      expect((config.description ?? "").length).toBeLessThan(400);
    }
  });

  test("read tools are annotated read-only and non-destructive", () => {
    for (const name of ["gd_node_get_property", "gd_get_logs", "gd_perf", "gd_status"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("gd_game_eval is annotated destructive and open-world", () => {
    const evalTool = registrations.find((r) => r.name === "gd_game_eval");
    expect(evalTool?.config.annotations?.destructiveHint).toBe(true);
    expect(evalTool?.config.annotations?.openWorldHint).toBe(true);
  });

  test("gd_undo and gd_redo are mutating but not flagged destructive", () => {
    for (const name of ["gd_undo", "gd_redo"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
      expect(tool?.config.annotations?.idempotentHint).toBe(false);
    }
  });

  test("gd_asset_add is annotated destructive and not idempotent", () => {
    const tool = registrations.find((r) => r.name === "gd_asset_add");
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.idempotentHint).toBe(false);
  });

  test("gd_editor_get_state and gd_script_validate are read-only and non-destructive", () => {
    for (const name of ["gd_editor_get_state", "gd_script_validate"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("gd_export_project is annotated destructive, idempotent, and not read-only", () => {
    const tool = registrations.find((r) => r.name === "gd_export_project");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.idempotentHint).toBe(true);
    expect(tool?.config.annotations?.openWorldHint).toBe(false);
  });

  test("read-only editor tools are annotated read-only and non-destructive", () => {
    for (const name of ["gd_editor_list_dialogs", "gd_editor_screenshot"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("dialog and tier-2 UI tools are annotated destructive", () => {
    for (const name of ["gd_editor_dialog_choose", "gd_editor_ui"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
    }
  });

  test("gd_debug is neither read-only nor destructive", () => {
    const tool = registrations.find((r) => r.name === "gd_debug");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(false);
  });

  test("phase 7 query and introspection tools are read-only and non-destructive", () => {
    for (const name of ["gd_classdb", "gd_find_nodes", "gd_scene_find_nodes", "gd_scene_node_get_property"]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(true);
      expect(tool?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  test("phase 7 mutating tools are annotated destructive", () => {
    for (const name of [
      "gd_scene_node_set_property",
      "gd_scene_instantiate",
      "gd_scene_signal",
      "gd_node_group",
      "gd_autoload",
      "gd_input_map",
    ]) {
      const tool = registrations.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
    }
  });
});

const PIXEL_TOOLS = [
  "gd_editor_pixel_click",
  "gd_editor_pixel_drag",
  "gd_editor_pixel_move",
  "gd_editor_window_info",
];

function registrationsWith(options: { enablePixelTools?: boolean; enableEditorEval?: boolean }): Registration[] {
  const { server, registrations } = collectRegistrations();
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, {
    enablePixelTools: options.enablePixelTools ?? false,
    enableEditorEval: options.enableEditorEval ?? false,
  });
  return registrations;
}

describe("tier-3 pixel tool gating", () => {
  test("pixel tools are absent from the default tool surface", () => {
    const names = registrationsWith({}).map((r) => r.name);
    for (const name of PIXEL_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  test("pixel tools are registered only when explicitly enabled", () => {
    const names = registrationsWith({ enablePixelTools: true }).map((r) => r.name).sort();
    for (const name of PIXEL_TOOLS) {
      expect(names).toContain(name);
    }
  });

  test("enabling pixel tools adds exactly the four tier-3 tools", () => {
    const off = new Set(registrationsWith({}).map((r) => r.name));
    const added = registrationsWith({ enablePixelTools: true })
      .map((r) => r.name)
      .filter((name) => !off.has(name))
      .sort();
    expect(added).toEqual(PIXEL_TOOLS);
  });

  test("pixel input tools are destructive and not idempotent; window_info is read-only", () => {
    const enabled = registrationsWith({ enablePixelTools: true });
    for (const name of ["gd_editor_pixel_move", "gd_editor_pixel_click", "gd_editor_pixel_drag"]) {
      const tool = enabled.find((r) => r.name === name);
      expect(tool?.config.annotations?.readOnlyHint).toBe(false);
      expect(tool?.config.annotations?.destructiveHint).toBe(true);
      expect(tool?.config.annotations?.idempotentHint).toBe(false);
      expect(tool?.config.annotations?.openWorldHint).toBe(false);
    }
    const info = enabled.find((r) => r.name === "gd_editor_window_info");
    expect(info?.config.annotations?.readOnlyHint).toBe(true);
    expect(info?.config.annotations?.destructiveHint).toBe(false);
  });
});

describe("editor eval gating", () => {
  test("gd_editor_eval is absent from the default tool surface", () => {
    const names = registrationsWith({}).map((r) => r.name);
    expect(names).not.toContain("gd_editor_eval");
  });

  test("enabling editor eval adds exactly one tool", () => {
    const off = new Set(registrationsWith({}).map((r) => r.name));
    const added = registrationsWith({ enableEditorEval: true })
      .map((r) => r.name)
      .filter((name) => !off.has(name));
    expect(added).toEqual(["gd_editor_eval"]);
  });

  test("gd_editor_eval is annotated destructive and open-world, like gd_game_eval", () => {
    const tool = registrationsWith({ enableEditorEval: true }).find((r) => r.name === "gd_editor_eval");
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.openWorldHint).toBe(true);
  });
});
