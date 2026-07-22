import { describe, expect, test } from "bun:test";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeManager } from "../src/bridge-manager.ts";
import { deriveInputSchema, ProjectToolsRegistry, type ToolEntry } from "../src/tools/project-tools.ts";

interface SpyRegistration {
  name: string;
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> };
  removed: boolean;
}

// A spy server that records registrations and supports remove(), mirroring the
// slice of the SDK's RegisteredTool the registry relies on.
function spyServer(): { server: McpServer; registrations: SpyRegistration[] } {
  const registrations: SpyRegistration[] = [];
  const server = {
    registerTool(name: string, config: SpyRegistration["config"]): RegisteredTool {
      const existing = registrations.find((r) => r.name === name && !r.removed);
      if (existing) {
        throw new Error(`Tool ${name} is already registered`);
      }
      const registration: SpyRegistration = { name, config, removed: false };
      registrations.push(registration);
      return {
        remove() {
          registration.removed = true;
        },
      } as unknown as RegisteredTool;
    },
  } as unknown as McpServer;
  return { server, registrations };
}

function entry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    method: "spawn_marker",
    node_path: "/root/Phase9/Tools",
    args: [
      { name: "marker_name", type: "String", required: true },
      { name: "count", type: "int", required: false },
    ],
    return_type: "int",
    ...overrides,
  };
}

function active(registrations: SpyRegistration[]): string[] {
  return registrations.filter((r) => !r.removed).map((r) => r.name).sort();
}

describe("deriveInputSchema", () => {
  const schema = deriveInputSchema(
    entry({
      args: [
        { name: "a_int", type: "int", required: true },
        { name: "a_float", type: "float", required: true },
        { name: "a_bool", type: "bool", required: true },
        { name: "a_string", type: "String", required: true },
        { name: "a_vec", type: "Vector2", required: true },
        { name: "a_var", type: "Variant", required: true },
        { name: "a_opt", type: "int", required: false },
      ],
    }),
  );

  test("maps Godot primitives onto typed zod fields", () => {
    expect(schema.a_int?.safeParse(3).success).toBe(true);
    expect(schema.a_int?.safeParse(3.5).success).toBe(false);
    expect(schema.a_float?.safeParse(3.5).success).toBe(true);
    expect(schema.a_bool?.safeParse(true).success).toBe(true);
    expect(schema.a_bool?.safeParse("yes").success).toBe(false);
    expect(schema.a_string?.safeParse("x").success).toBe(true);
    expect(schema.a_string?.safeParse(1).success).toBe(false);
  });

  test("non-primitive and untyped args accept tagged JSON", () => {
    expect(schema.a_vec?.safeParse({ __type: "Vector2", x: 1, y: 2 }).success).toBe(true);
    expect(schema.a_var?.safeParse("anything").success).toBe(true);
    expect((schema.a_vec as z.ZodTypeAny).description).toContain("Vector2");
  });

  test("defaulted args are optional; required args are not", () => {
    expect(schema.a_opt?.safeParse(undefined).success).toBe(true);
    expect(schema.a_int?.safeParse(undefined).success).toBe(false);
  });

  test("the shared instance field is present", () => {
    expect(schema.instance).toBeDefined();
  });
});

describe("ProjectToolsRegistry sync", () => {
  const manager = {} as unknown as BridgeManager;

  test("registers new tools under gd_project_ names", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry(), entry({ method: "get_speed", args: [], return_type: "float" })]);
    expect(active(registrations)).toEqual(["gd_project_get_speed", "gd_project_spawn_marker"]);
    expect(registry.names()).toEqual(["gd_project_get_speed", "gd_project_spawn_marker"]);
  });

  test("removes departed tools and keeps surviving ones", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry(), entry({ method: "get_speed", args: [], return_type: "float" })]);
    registry.sync([entry()]);
    expect(active(registrations)).toEqual(["gd_project_spawn_marker"]);
  });

  test("a signature change re-registers the tool", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry()]);
    registry.sync([entry({ return_type: "float" })]);
    const spawns = registrations.filter((r) => r.name === "gd_project_spawn_marker");
    expect(spawns.length).toBe(2);
    expect(spawns[0]?.removed).toBe(true);
    expect(spawns[1]?.removed).toBe(false);
  });

  test("an unchanged signature is not re-registered", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry()]);
    registry.sync([entry()]);
    expect(registrations.filter((r) => r.name === "gd_project_spawn_marker").length).toBe(1);
  });

  test("invalid method names are skipped", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry({ method: "bad name" }), entry({ method: "_underscore" }), entry({ method: "ok_name" })]);
    expect(active(registrations)).toEqual(["gd_project_ok_name"]);
  });

  test("cross-node collisions keep the first node", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry(), entry({ node_path: "/root/Phase9/Other" })]);
    const spawns = registrations.filter((r) => r.name === "gd_project_spawn_marker" && !r.removed);
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.config.description).toContain("/root/Phase9/Tools");
  });

  test("a static-name collision is skipped instead of throwing", () => {
    const { server, registrations } = spyServer();
    // Simulate a static tool already claiming the name.
    (server as unknown as { registerTool: (n: string, c: SpyRegistration["config"]) => unknown }).registerTool(
      "gd_project_scaffold",
      {},
    );
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry({ method: "scaffold" })]);
    expect(registry.names()).toEqual([]);
    expect(active(registrations)).toEqual(["gd_project_scaffold"]);
  });

  test("clear removes everything", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry(), entry({ method: "get_speed", args: [], return_type: "float" })]);
    registry.clear();
    expect(active(registrations)).toEqual([]);
    expect(registry.names()).toEqual([]);
  });

  test("project tools are annotated destructive", () => {
    const { server, registrations } = spyServer();
    const registry = new ProjectToolsRegistry(server, manager);
    registry.sync([entry()]);
    const tool = registrations.find((r) => r.name === "gd_project_spawn_marker");
    expect(tool?.config.annotations?.destructiveHint).toBe(true);
    expect(tool?.config.annotations?.readOnlyHint).toBe(false);
  });
});
