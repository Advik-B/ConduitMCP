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
  "gd_game_eval",
  "gd_game_list",
  "gd_get_errors",
  "gd_get_events",
  "gd_get_logs",
  "gd_input",
  "gd_node_call",
  "gd_node_get_info",
  "gd_node_get_property",
  "gd_node_set_property",
  "gd_pause",
  "gd_perf",
  "gd_ping",
  "gd_play",
  "gd_screenshot",
  "gd_set_time_scale",
  "gd_signal",
  "gd_status",
  "gd_step_frames",
  "gd_stop",
  "gd_tree_get",
  "gd_wait_frames",
  "gd_wait_time",
];

describe("tool definitions", () => {
  const { server, registrations } = collectRegistrations();
  // The manager and events are only used inside handlers, not during registration.
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing);

  test("registers exactly the phase 2 tool surface", () => {
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
});
