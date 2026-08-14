import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuditLog } from "../src/audit.ts";
import type { BridgeManager } from "../src/bridge-manager.ts";
import type { EventRing } from "../src/events.ts";
import { GodotResolver } from "../src/godot-locate.ts";
import { registerTools, type ToolOptions } from "../src/index.ts";
import { DEFAULT_TIMEOUTS } from "../src/tool-helpers.ts";
import {
  TOOL_GROUPS,
  TOOL_GROUP_BY_NAME,
  ToolGroupError,
  parseToolGroups,
  wrapServer,
} from "../src/tool-registry.ts";

interface Recorder {
  server: McpServer;
  names: string[];
  callbacks: Map<string, (...args: unknown[]) => unknown>;
}

function recorder(): Recorder {
  const names: string[] = [];
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  const server = {
    registerTool(name: string, _config: unknown, callback: (...args: unknown[]) => unknown) {
      names.push(name);
      callbacks.set(name, callback);
      return { remove() {} };
    },
  } as unknown as McpServer;
  return { server, names, callbacks };
}

function options(overrides: Partial<ToolOptions> = {}): ToolOptions {
  return {
    enablePixelTools: false,
    enableEditorEval: false,
    disableEval: false,
    godot: new GodotResolver(null),
    projectPath: null,
    runtimeDir: "",
    addonSource: null,
    timeouts: DEFAULT_TIMEOUTS,
    ...overrides,
  };
}

function register(server: McpServer, overrides: Partial<ToolOptions> = {}): void {
  registerTools(server, {} as unknown as BridgeManager, {} as unknown as EventRing, options(overrides));
}

describe("the group table", () => {
  // The check that keeps the table honest when tool 90 is added.
  test("every registered tool has a group, on the default and the fully opted-in surface", () => {
    for (const overrides of [{}, { enablePixelTools: true, enableEditorEval: true }]) {
      const target = recorder();
      register(target.server, overrides);
      expect(target.names.filter((name) => !TOOL_GROUP_BY_NAME[name])).toEqual([]);
    }
  });

  test("every declared group is reachable from some tool", () => {
    const used = new Set(Object.values(TOOL_GROUP_BY_NAME));
    expect(TOOL_GROUPS.filter((group) => !used.has(group))).toEqual([]);
  });
});

describe("parseToolGroups", () => {
  test("an empty or absent value keeps everything", () => {
    expect(parseToolGroups(null)).toBeNull();
    expect(parseToolGroups("  ")).toBeNull();
  });

  test("a plain list is an allowlist and always includes core", () => {
    expect(parseToolGroups("scene,runtime")).toEqual(new Set(["scene", "runtime", "core"]));
  });

  test("a dash-prefixed list subtracts from the full set", () => {
    const groups = parseToolGroups("-net,-audio") as Set<string>;
    expect(groups.has("net")).toBe(false);
    expect(groups.has("audio")).toBe(false);
    expect(groups.has("scene")).toBe(true);
    expect(groups.has("core")).toBe(true);
  });

  test("mixing the two forms, an unknown group, or naming core is an error", () => {
    expect(() => parseToolGroups("scene,-net")).toThrow(ToolGroupError);
    expect(() => parseToolGroups("bogus")).toThrow(/unknown tool group "bogus"/);
    expect(() => parseToolGroups("core")).toThrow(/core group is always registered/);
  });
});

describe("wrapServer group filtering", () => {
  test("dropping a group removes exactly its tools", () => {
    const unfiltered = recorder();
    register(unfiltered.server);
    const filtered = recorder();
    register(wrapServer(filtered.server, { groups: parseToolGroups("-net,-audio") }));

    const removed = unfiltered.names.filter((name) => !filtered.names.includes(name));
    expect(removed.sort()).toEqual(["gd_audio", "gd_http_request", "gd_multiplayer", "gd_websocket"]);
  });

  test("an allowlist keeps core alongside the named groups and nothing else", () => {
    const target = recorder();
    register(wrapServer(target.server, { groups: parseToolGroups("scene") }));
    const groups = new Set(target.names.map((name) => TOOL_GROUP_BY_NAME[name]));
    expect([...groups].sort()).toEqual(["core", "scene"]);
    expect(target.names).toContain("gd_status");
    expect(target.names).toContain("gd_addon_install");
  });

  // Group filtering can only subtract from what the safety flags already
  // permit: naming a group must never reopen one they closed.
  test("naming the eval group does not reopen --disable-eval", () => {
    const target = recorder();
    register(wrapServer(target.server, { groups: parseToolGroups("eval") }), { disableEval: true });
    expect(target.names).not.toContain("gd_game_eval");
    expect(target.names).not.toContain("gd_editor_eval");
    expect(target.names).not.toContain("gd_http_request");
  });

  test("naming the pixel group does not substitute for the opt-in", () => {
    const target = recorder();
    register(wrapServer(target.server, { groups: parseToolGroups("pixel") }));
    expect(target.names.some((name) => name.startsWith("gd_editor_pixel"))).toBe(false);
  });

  test("with no audit and no groups the server is passed through untouched", () => {
    const target = recorder();
    expect(wrapServer(target.server, {})).toBe(target.server);
  });
});

describe("wrapServer audit interception", () => {
  test("times every call and leaves the result unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-registry-test-"));
    try {
      const file = path.join(dir, "audit.jsonl");
      const audit = new AuditLog(file, 1024 * 1024);
      const target = recorder();
      const wrapped = wrapServer(target.server, { audit });

      const ok = { content: [{ type: "text", text: "{}" }] };
      const bad = { content: [{ type: "text", text: "boom: no" }], isError: true };
      wrapped.registerTool("gd_ping", {} as never, (async () => ok) as never);
      wrapped.registerTool("gd_play", {} as never, (async () => bad) as never);

      expect(await target.callbacks.get("gd_ping")?.({ a: 1 })).toBe(ok);
      expect(await target.callbacks.get("gd_play")?.({})).toBe(bad);

      const lines = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ tool: "gd_ping", outcome: "ok", args: { a: 1 } });
      expect(lines[1]).toMatchObject({ tool: "gd_play", outcome: "error" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // "Every tool call" has to include the ones that failed unexpectedly; those
  // are the calls the log exists for.
  test("a callback that throws is recorded and the error still propagates", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduit-registry-throw-"));
    try {
      const file = path.join(dir, "audit.jsonl");
      const audit = new AuditLog(file, 1024 * 1024);
      const target = recorder();
      wrapServer(target.server, { audit }).registerTool(
        "gd_ping",
        {} as never,
        (async () => {
          throw new Error("schema rejected");
        }) as never,
      );

      await expect(target.callbacks.get("gd_ping")?.({})).rejects.toThrow("schema rejected");
      const record = JSON.parse(fs.readFileSync(file, "utf8").trim());
      expect(record).toMatchObject({ tool: "gd_ping", outcome: "error" });
      expect(record.error).toContain("schema rejected");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Dynamic gd_project_* names cannot be in a static table, so they must pass
  // through rather than be filtered out.
  test("a tool absent from the table is registered and audited, not dropped", async () => {
    const target = recorder();
    const wrapped = wrapServer(target.server, { groups: parseToolGroups("scene") });
    wrapped.registerTool("gd_project_spawn_wave", {} as never, (async () => ({ content: [] })) as never);
    expect(target.names).toContain("gd_project_spawn_wave");
  });
});
