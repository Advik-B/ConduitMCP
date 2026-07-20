#!/usr/bin/env bun
// Conduit broker: an MCP server over stdio that aggregates the Godot editor and
// game bridges and presents one unified tool surface (whitepaper sections 6.2
// and 7.1). The broker owns MCP correctness; the bridges own engine work.
//
// Hard rule: nothing but MCP protocol frames may reach stdout. All broker
// logging goes to stderr (whitepaper section 7.1).

import os from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeManager } from "./bridge-manager.ts";
import { BridgeError } from "./ipc-client.ts";
import { EventRing } from "./events.ts";
import { shortHash } from "./framing.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const AWAIT_TIMEOUT_MS = 120_000;
const GAME_CONNECT_TIMEOUT_MS = 20_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: true;
};

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

interface Config {
  runtimeDir: string;
  projectPath: string | null;
  editorSocketPath: string;
}

function resolveConfig(): Config {
  const runtimeDir = process.env.CONDUIT_RUNTIME_DIR || os.tmpdir();
  const projectPath = process.env.CONDUIT_PROJECT ?? null;
  const editorSocketPath =
    process.env.CONDUIT_SOCK ??
    (projectPath ? join(runtimeDir, `conduit-editor-${shortHash(projectPath)}.sock`) : null);
  if (!editorSocketPath) {
    throw new Error("set CONDUIT_SOCK or CONDUIT_PROJECT so the broker can locate the editor bridge socket");
  }
  return { runtimeDir, projectPath, editorSocketPath };
}

function toToolError(error: unknown): ToolResult {
  if (error instanceof BridgeError) {
    return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `internal_error: ${message}` }], isError: true };
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const instanceField = { instance: z.number().int().describe("Game instance pid; defaults to the most recent.").optional() };

export function registerTools(server: McpServer, manager: BridgeManager, events: EventRing): void {
  const gameTool = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): void => {
    server.registerTool(name, { description, inputSchema: { ...inputSchema, ...instanceField }, annotations }, async (args) => {
      try {
        const { instance, ...rest } = args as Record<string, unknown> & { instance?: number };
        const result = await manager.gameRequest(name, rest, timeoutMs, instance);
        return textResult(result);
      } catch (error) {
        return toToolError(error);
      }
    });
  };

  const editorTool = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, boolean>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): void => {
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        const result = await manager.editorRequest(name, args as Record<string, unknown>, timeoutMs);
        return textResult(result);
      } catch (error) {
        return toToolError(error);
      }
    });
  };

  editorTool(
    "gd_ping",
    "Round-trip a no-op command through the editor bridge to prove it is connected and responsive.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  server.registerTool(
    "gd_play",
    {
      description:
        "Run the game from the editor, spawning the game process and its bridge. Plays the main scene by default, the current scene, or a res:// scene path. Waits for the game bridge to connect and reports the instance.",
      inputSchema: { scene: z.string().describe("'main', 'current', or a res:// scene path.").optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ scene }) => {
      try {
        const playArgs = scene ? { scene } : {};
        const playResult = (await manager.editorRequest("gd_play", playArgs, DEFAULT_TIMEOUT_MS)) as Record<string, unknown>;
        try {
          const instance = await manager.waitForGame(GAME_CONNECT_TIMEOUT_MS);
          return textResult({
            ...playResult,
            game_bridge_connected: true,
            instance: { pid: instance.hello.pid, engine_version: instance.hello.engine_version },
          });
        } catch {
          return textResult({
            ...playResult,
            game_bridge_connected: false,
            note: "the game launched but its bridge did not connect; confirm the game was started with the conduit opt-in (CONDUIT_ENABLE or --conduit)",
          });
        }
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  editorTool(
    "gd_stop",
    "Stop the running game. The broker reports a game_exited event when the game process quits.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_tree_get",
    "Dump the running scene tree from a root, depth-limited so a large scene does not flood context.",
    {
      root_path: z.string().describe("Absolute node path to start from; defaults to the current scene root.").optional(),
      max_depth: z.number().int().min(0).describe("Maximum tree depth to include (default 3).").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_node_get_info",
    "Report a node's class, children, and property, signal, and method names.",
    { node_path: z.string().describe("Absolute path to the node, for example /root/Main/Player.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_node_get_property",
    "Read one property of a live node, returned as tagged JSON.",
    {
      node_path: z.string().describe("Absolute path to the node."),
      property: z.string().describe("Property name, for example position."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_node_set_property",
    "Set one property of a live node and return its previous value. Values may be plain JSON or tagged Godot types ({\"__type\":\"Vector2\",\"x\":..,\"y\":..}).",
    {
      node_path: z.string().describe("Absolute path to the node."),
      property: z.string().describe("Property name to write."),
      value: z.any().describe("New value; plain JSON or a tagged Godot type."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  gameTool(
    "gd_node_call",
    "Call a method on a live node with converted arguments and return its result.",
    {
      node_path: z.string().describe("Absolute path to the node."),
      method: z.string().describe("Method name to call."),
      args: z.array(z.any()).describe("Positional arguments; plain JSON or tagged Godot types.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  );

  gameTool(
    "gd_game_eval",
    "Evaluate a GDScript snippet in the running game and return the result. Supports await; the call resolves when the coroutine completes. Arbitrary code, so highest capability and highest risk.",
    { source: z.string().describe("GDScript to run; prefix with 'return' or include a return statement to yield a value.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    AWAIT_TIMEOUT_MS,
  );

  gameTool(
    "gd_signal",
    "Signal operations selected by op: connect, disconnect, emit, list, or await (await suspends until the signal fires).",
    {
      op: z.enum(["connect", "disconnect", "emit", "list", "await"]).describe("Which signal operation to perform."),
      node_path: z.string().describe("Absolute path to the emitting node.").optional(),
      signal: z.string().describe("Signal name.").optional(),
      target_path: z.string().describe("Absolute path to the connection target node (connect/disconnect).").optional(),
      method: z.string().describe("Target method name (connect/disconnect).").optional(),
      args: z.array(z.any()).describe("Arguments to emit.").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  gameTool(
    "gd_input",
    "Simulate input, selected by device: key, action, mouse_button, or mouse_motion. A press without a matching release models a held key across frames.",
    {
      device: z.enum(["key", "action", "mouse_button", "mouse_motion"]).describe("Which input device to synthesise."),
      key: z.string().describe("Key name (device=key), for example 'right' or 'A'.").optional(),
      keycode: z.number().int().describe("Godot keycode (device=key), an alternative to key.").optional(),
      physical: z.boolean().describe("Treat the key as a physical keycode.").optional(),
      pressed: z.boolean().describe("Pressed (true, default) or released (false).").optional(),
      action: z.string().describe("Input-map action name (device=action).").optional(),
      strength: z.number().describe("Action strength 0..1 (device=action).").optional(),
      button: z.union([z.string(), z.number()]).describe("Mouse button (device=mouse_button).").optional(),
      position: z.any().describe("Screen position {x,y} for mouse events.").optional(),
      relative: z.any().describe("Relative motion {x,y} (device=mouse_motion).").optional(),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  );

  server.registerTool(
    "gd_screenshot",
    {
      description:
        "Capture a screenshot of the running game after the next drawn frame, returned as an image. Reports not_available_headless under a headless display server.",
      inputSchema: {
        max_dimension: z.number().int().min(1).describe("Longest-edge pixel cap; the image is scaled to fit.").optional(),
        format: z.enum(["png", "jpg"]).describe("Image format (default png).").optional(),
        ...instanceField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const { instance, ...rest } = args as Record<string, unknown> & { instance?: number };
        const result = (await manager.gameRequest("gd_screenshot", rest, AWAIT_TIMEOUT_MS, instance)) as {
          image_base64: string;
          format: string;
        };
        const mimeType = result.format === "jpg" ? "image/jpeg" : "image/png";
        return { content: [{ type: "image", data: result.image_base64, mimeType }] };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  gameTool(
    "gd_perf",
    "Read runtime performance counters: framerate, frame time, memory, and object, node, and draw-call counts.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_get_logs",
    "Read game log output appended since the last call, capped by max_bytes (the tail is kept when clipped).",
    { max_bytes: z.number().int().min(1).describe("Maximum bytes to return (default 65536).").optional() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  gameTool(
    "gd_get_errors",
    "Read new error and warning lines from the game log since the last call.",
    { max_bytes: z.number().int().min(1).describe("Maximum bytes to scan (default 65536).").optional() },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  );

  gameTool(
    "gd_pause",
    "Pause or unpause the running game's scene tree.",
    { paused: z.boolean().describe("Pause (true, default) or unpause (false).").optional() },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  gameTool(
    "gd_step_frames",
    "Advance a paused game a precise number of frames, then restore the previous pause state.",
    { frames: z.number().int().min(1).describe("Number of frames to advance.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  gameTool(
    "gd_wait_time",
    "Wait a number of seconds of game time (accumulated from rendered-frame deltas), then return.",
    { seconds: z.number().positive().describe("Seconds of game time to wait.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  gameTool(
    "gd_wait_frames",
    "Wait a number of rendered frames, then return; completes via deferred resolution without blocking the game.",
    { frames: z.number().int().min(1).describe("Number of frames to wait.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    AWAIT_TIMEOUT_MS,
  );

  gameTool(
    "gd_set_time_scale",
    "Set the engine time scale (1.0 normal, 0.5 half speed, 2.0 double).",
    { scale: z.number().min(0).describe("Non-negative time scale multiplier.") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  );

  server.registerTool(
    "gd_status",
    {
      description: "Report broker status: editor connection and engine version, and the connected game instances.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => textResult(manager.status()),
  );

  server.registerTool(
    "gd_game_list",
    {
      description: "List the currently connected game instances with their pid and engine version.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => textResult({ games: manager.listGames() }),
  );

  server.registerTool(
    "gd_get_events",
    {
      description: "Read lifecycle events (game started, exited, editor disconnected) since a cursor.",
      inputSchema: { cursor: z.number().int().min(0).describe("Sequence cursor from a previous call; omit for all retained.").optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cursor }) => textResult(events.since(cursor ?? 0)),
  );
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const server = new McpServer({ name: "conduit", version: "0.2.0" });

  const events = new EventRing(256, (event) => {
    try {
      server.server.sendLoggingMessage({ level: "info", logger: "conduit", data: event });
    } catch {
      // The client may not have enabled logging, or the transport is not up yet.
    }
  });

  const manager = new BridgeManager({
    editorSocketPath: config.editorSocketPath,
    runtimeDir: config.runtimeDir,
    projectPath: config.projectPath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    events,
  });

  log(`connecting to editor bridge at ${config.editorSocketPath}`);
  const hello = await manager.connectEditor();
  log(`connected to editor bridge (engine ${hello.engine_version})`);

  registerTools(server, manager, events);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio");
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
