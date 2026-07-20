import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BridgeClient } from "../src/ipc-client.ts";
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

describe("tool definitions", () => {
  const { server, registrations } = collectRegistrations();
  // The client is never called during registration, only wired into handlers.
  registerTools(server, {} as unknown as BridgeClient);

  test("registers exactly the phase 1 tools", () => {
    const names = registrations.map((r) => r.name).sort();
    expect(names).toEqual(["gd_ping", "gd_wait_frames"]);
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

  test("gd_ping is annotated read-only and non-destructive", () => {
    const ping = registrations.find((r) => r.name === "gd_ping");
    expect(ping?.config.annotations?.readOnlyHint).toBe(true);
    expect(ping?.config.annotations?.destructiveHint).toBe(false);
  });
});
