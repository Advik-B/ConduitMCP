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
  "gd_editor_get_state",
  "gd_file_delete",
  "gd_file_move",
  "gd_game_eval",
  "gd_game_list",
  "gd_get_errors",
  "gd_get_events",
  "gd_get_logs",
  "gd_input",
  "gd_node_add",
  "gd_node_call",
  "gd_node_duplicate",
  "gd_node_get_info",
  "gd_node_get_property",
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
  "gd_scene_open",
  "gd_scene_save",
  "gd_scene_save_all",
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
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing);

  test("registers exactly the phase 1-3 tool surface", () => {
    const names = registrations.map((r) => r.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
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
});
