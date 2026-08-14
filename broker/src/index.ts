#!/usr/bin/env bun
// Conduit broker: an MCP server over stdio that aggregates the Godot editor and
// game bridges and presents one unified tool surface (whitepaper sections 6.2
// and 7.1). The broker owns MCP correctness; the bridges own engine work.
//
// Hard rule: nothing but MCP protocol frames may reach stdout. All broker
// logging goes to stderr (whitepaper section 7.1).

import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// The workspace Cargo.toml is the single source of the project version; the
// bridge reads it as CARGO_PKG_VERSION and the broker bundles it here.
import cargo from "../../Cargo.toml";

const VERSION: string = cargo.workspace.package.version;

import { type AddonDetection, detectAddon, installAddon } from "./addon.ts";
import { AuditLog } from "./audit.ts";
import { BridgeManager } from "./bridge-manager.ts";
import { type CliOptions, applyTransportEnv, runCli } from "./cli.ts";
import { type Endpoint, editorEndpoint, editorEndpointFromOverride, endpointKey } from "./endpoint.ts";
import { envFlag, envInt } from "./env.ts";
import { EventRing } from "./events.ts";
import { GodotResolver } from "./godot-locate.ts";
import { registerClassDbTools } from "./tools/classdb.ts";
import { registerEditorAssetsTools } from "./tools/editor-assets.ts";
import { registerEditorCollabTools } from "./tools/editor-collab.ts";
import { registerEditorDebugTools } from "./tools/editor-debug.ts";
import { registerEditorEvalTools } from "./tools/editor-eval.ts";
import { registerEditorExportTools } from "./tools/editor-export.ts";
import { registerEditorFilesTools } from "./tools/editor-files.ts";
import { registerEditorPixelTools } from "./tools/editor-pixel.ts";
import { registerEditorProjectTools } from "./tools/editor-project.ts";
import { registerEditorResourceTools } from "./tools/editor-resource.ts";
import { registerEditorSceneTools } from "./tools/editor-scene.ts";
import { registerEditorScriptTools } from "./tools/editor-script.ts";
import { registerEditorStateTools } from "./tools/editor-state.ts";
import { registerEditorWiringTools } from "./tools/editor-wiring.ts";
import { parseToolGroups, wrapServer } from "./tool-registry.ts";
import { ProjectToolsRegistry, type ToolEntry } from "./tools/project-tools.ts";
import { registerSessionTools } from "./tools/session.ts";
import { registerGameAnimationTools } from "./tools/game-animation.ts";
import { registerGameAudioTools } from "./tools/game-audio.ts";
import { registerGameNetTools } from "./tools/game-net.ts";
import { registerGamePhysicsTools } from "./tools/game-physics.ts";
import { registerGameRenderTools } from "./tools/game-render.ts";
import { registerGameTilemapTools } from "./tools/game-tilemap.ts";
import { registerGameTreeTools } from "./tools/game-tree.ts";
import { registerGameWindowTools } from "./tools/game-window.ts";
import {
  AWAIT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  type Timeouts,
  instanceField,
  makeEditorTool,
  makeGameTool,
  textResult,
  toToolError,
} from "./tool-helpers.ts";

const GAME_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_AUDIT_MAX_BYTES = 16 * 1024 * 1024;

function log(message: string): void {
  process.stderr.write(`conduit-broker: ${message}\n`);
}

interface Config {
  runtimeDir: string;
  projectPath: string | null;
  editorEndpoint: Endpoint;
  enablePixelTools: boolean;
  enableEditorEval: boolean;
  disableEval: boolean;
  godot: GodotResolver;
  autoInstall: boolean;
  addonSource: string | null;
  timeouts: Timeouts;
  auditLog: string | null;
  auditMaxBytes: number;
  toolGroups: string | null;
}

/**
 * Turn parsed arguments into the broker's configuration. Command-line options
 * take precedence over environment variables (whitepaper section 15), which is
 * why every `??` chain below reads option first: an option is undefined when it
 * was not passed, never a default. Booleans use `?? envFlag(...)` so an explicit
 * `--no-x` still beats the variable.
 *
 * Exported for tests: this is the only place precedence is decided.
 */
export function resolveConfig(cli: CliOptions, env: NodeJS.ProcessEnv = process.env): Config {
  const runtimeDir = env.CONDUIT_RUNTIME_DIR || os.tmpdir();
  const rawProjectPath = cli.project ?? env.CONDUIT_PROJECT ?? null;
  // Resolve once, here. The addon installer writes files under this path and an
  // MCP client spawns the broker with an arbitrary cwd, so a relative --project
  // would otherwise land somewhere unpredictable. It also makes the derived hash
  // agree with the bridge, which builds its side from globalize_path("res://")
  // and is therefore always absolute.
  const projectPath = rawProjectPath ? path.resolve(rawProjectPath) : null;
  const override = env.CONDUIT_SOCK;
  const resolvedEndpoint: Endpoint | null = override
    ? editorEndpointFromOverride(override)
    : projectPath
      ? editorEndpoint(runtimeDir, projectPath)
      : null;
  if (!resolvedEndpoint) {
    throw new Error("set --project, CONDUIT_PROJECT, or CONDUIT_SOCK so the broker can locate the editor bridge");
  }
  const auditLog = cli.auditLog ?? env.CONDUIT_AUDIT_LOG ?? null;
  return {
    runtimeDir,
    projectPath,
    editorEndpoint: resolvedEndpoint,
    enablePixelTools: cli.enablePixelTools ?? envFlag(env.CONDUIT_ENABLE_PIXEL_TOOLS),
    enableEditorEval: cli.enableEditorEval ?? envFlag(env.CONDUIT_ENABLE_EDITOR_EVAL),
    disableEval: cli.disableEval ?? envFlag(env.CONDUIT_DISABLE_EVAL),
    godot: new GodotResolver(cli.godot ?? env.CONDUIT_GODOT ?? null),
    autoInstall: cli.autoInstall ?? envFlag(env.CONDUIT_AUTO_INSTALL),
    addonSource: cli.addonSource ?? env.CONDUIT_ADDON_SOURCE ?? null,
    timeouts: {
      default: cli.timeoutMs ?? envInt("CONDUIT_TIMEOUT_MS", env.CONDUIT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
      await: cli.evalTimeoutMs ?? envInt("CONDUIT_EVAL_TIMEOUT_MS", env.CONDUIT_EVAL_TIMEOUT_MS) ?? AWAIT_TIMEOUT_MS,
      export: cli.exportTimeoutMs ?? envInt("CONDUIT_EXPORT_TIMEOUT_MS", env.CONDUIT_EXPORT_TIMEOUT_MS) ?? EXPORT_TIMEOUT_MS,
    },
    // "off" is the documented way to disable it from a config file that can set
    // a variable but not unset one.
    auditLog: auditLog && auditLog.toLowerCase() !== "off" ? path.resolve(auditLog) : null,
    auditMaxBytes:
      cli.auditMaxBytes ?? envInt("CONDUIT_AUDIT_MAX_BYTES", env.CONDUIT_AUDIT_MAX_BYTES) ?? DEFAULT_AUDIT_MAX_BYTES,
    toolGroups: cli.toolGroups ?? env.CONDUIT_TOOL_GROUPS ?? null,
  };
}

/** Tool-surface options resolved from configuration. */
export interface ToolOptions {
  enablePixelTools: boolean;
  enableEditorEval: boolean;
  disableEval: boolean;
  godot: GodotResolver;
  projectPath: string | null;
  runtimeDir: string;
  addonSource: string | null;
  timeouts: Timeouts;
  // Extra fields merged into gd_status: engine resolution and addon install
  // state live outside the BridgeManager, which only knows about connections.
  extraStatus?: () => Record<string, unknown>;
  onInstallOutcome?: (outcome: { error: string | null; source: string | null }) => void;
}

export function registerTools(server: McpServer, manager: BridgeManager, events: EventRing, options: ToolOptions): void {
  const timeouts = options.timeouts;
  const gameTool = makeGameTool(server, manager, timeouts);
  const editorTool = makeEditorTool(server, manager, timeouts);

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
        // Snapshot before the play request: the background discovery loop may
        // adopt the new game before waitForGame runs, so "new" is measured
        // against the instances known before the launch.
        const known = manager.knownGamePids();
        const playArgs = scene ? { scene } : {};
        const playResult = (await manager.editorRequest("gd_play", playArgs, options.timeouts.default)) as Record<string, unknown>;
        try {
          const instance = await manager.waitForGame(GAME_CONNECT_TIMEOUT_MS, known);
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
    "gd_find_nodes",
    "Find nodes in the running scene tree by engine class, group membership, or name glob (* and ?). At least one filter is required; results paginate via limit/offset and report absolute paths.",
    {
      class: z.string().describe("Match nodes of this engine class (inheritance-aware).").optional(),
      group: z.string().describe("Match nodes in this group.").optional(),
      name_pattern: z.string().describe("Match node names against this glob, for example Enemy*.").optional(),
      root_path: z.string().describe("Absolute node path to search under; defaults to the tree root.").optional(),
      limit: z.number().int().min(1).describe("Page size (default 50).").optional(),
      offset: z.number().int().min(0).describe("Start offset from a previous next_offset.").optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

  // Eval-class surface: gd_game_eval and everything with equivalent authority
  // (editor eval, project-defined tools, networking) drops together under
  // --disable-eval for restricted deployments (whitepaper sections 9 and 15).
  if (!options.disableEval) {
    gameTool(
      "gd_game_eval",
      "Evaluate a GDScript snippet in the running game and return the result. Supports await; the call resolves when the coroutine completes. Arbitrary code, so highest capability and highest risk.",
      { source: z.string().describe("GDScript to run; prefix with 'return' or include a return statement to yield a value.") },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      "await",
    );
  }

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
    "await",
  );

  gameTool(
    "gd_input",
    "Simulate input, selected by device: key, action, mouse_button, mouse_motion, joy_button, joy_motion, touch, touch_drag, magnify, or pan. A press without a matching release models a held key or button; a nonzero joy_motion value holds the bound action's strength until a 0.0 release (Input.get_joy_axis reflects only real devices).",
    {
      device: z
        .enum(["key", "action", "mouse_button", "mouse_motion", "joy_button", "joy_motion", "touch", "touch_drag", "magnify", "pan"])
        .describe("Which input device to synthesise."),
      key: z.string().describe("Key name (device=key), for example 'right' or 'A'.").optional(),
      keycode: z.number().int().describe("Godot keycode (device=key), an alternative to key.").optional(),
      physical: z.boolean().describe("Treat the key as a physical keycode.").optional(),
      pressed: z.boolean().describe("Pressed (true, default) or released (false).").optional(),
      action: z.string().describe("Input-map action name (device=action).").optional(),
      strength: z.number().describe("Action strength 0..1 (device=action).").optional(),
      button: z
        .union([z.string(), z.number()])
        .describe("Mouse button (device=mouse_button) or joypad button name/ordinal like a, lb, dpad_up (device=joy_button).")
        .optional(),
      axis: z
        .union([z.string(), z.number()])
        .describe("Joypad axis name or ordinal: left_x, left_y, right_x, right_y, trigger_left, trigger_right (device=joy_motion).")
        .optional(),
      value: z.number().describe("Axis value -1.0 to 1.0 (device=joy_motion).").optional(),
      device_id: z.number().int().describe("Joypad device id (default 0).").optional(),
      position: z.any().describe("Screen position {x,y} for mouse, touch, and gesture events.").optional(),
      relative: z.any().describe("Relative motion {x,y} (mouse_motion, touch_drag).").optional(),
      index: z.number().int().describe("Touch finger index (touch, touch_drag, default 0).").optional(),
      double_tap: z.boolean().describe("Mark the touch as a double tap (device=touch).").optional(),
      velocity: z.any().describe("Drag velocity {x,y} (device=touch_drag).").optional(),
      factor: z.number().describe("Magnification factor (device=magnify).").optional(),
      delta: z.any().describe("Pan delta {x,y} (device=pan).").optional(),
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
        const result = (await manager.gameRequest("gd_screenshot", rest, options.timeouts.await, instance)) as {
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
    "await",
  );

  gameTool(
    "gd_wait_time",
    "Wait a number of seconds of game time (accumulated from rendered-frame deltas), then return.",
    { seconds: z.number().positive().describe("Seconds of game time to wait.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    "await",
  );

  gameTool(
    "gd_wait_frames",
    "Wait a number of rendered frames, then return; completes via deferred resolution without blocking the game.",
    { frames: z.number().int().min(1).describe("Number of frames to wait.") },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    "await",
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
      description:
        "Report broker status: editor connection and engine version, the connected game instances, the resolved engine binary, and the addon install state of the configured project.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => textResult({ ...manager.status(), ...(options.extraStatus?.() ?? {}) }),
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

  registerGameAnimationTools(server, manager, timeouts);
  registerGamePhysicsTools(server, manager, timeouts);
  registerGameRenderTools(server, manager, timeouts);
  registerGameAudioTools(server, manager, timeouts);
  registerGameTilemapTools(server, manager, timeouts);
  registerGameWindowTools(server, manager, timeouts);
  registerGameTreeTools(server, manager, timeouts);
  // Networking reaches outside the machine on the agent's behalf: eval-class
  // (section 9), dropped together with gd_game_eval.
  if (!options.disableEval) {
    registerGameNetTools(server, manager, timeouts);
  }

  registerSessionTools(server, manager, {
    godot: options.godot,
    projectPath: options.projectPath,
    runtimeDir: options.runtimeDir,
    addonSource: options.addonSource,
    version: VERSION,
    onInstallOutcome: options.onInstallOutcome,
  });

  registerClassDbTools(server, manager, timeouts);
  registerEditorSceneTools(server, manager, timeouts);
  registerEditorWiringTools(server, manager, timeouts);
  registerEditorScriptTools(server, manager, timeouts);
  registerEditorResourceTools(server, manager, timeouts);
  registerEditorProjectTools(server, manager, timeouts);
  registerEditorStateTools(server, manager, timeouts);
  registerEditorAssetsTools(server, manager, timeouts);
  registerEditorFilesTools(server, manager, timeouts);
  registerEditorExportTools(server, manager, timeouts);
  registerEditorDebugTools(server, manager, timeouts);
  registerEditorCollabTools(server, manager, timeouts);

  // Tier-3 pixel fallback: registered only under an explicit opt-in (section 15),
  // so the default tool surface never exposes it.
  if (options.enablePixelTools) {
    registerEditorPixelTools(server, manager, timeouts);
  }

  // Editor-process evaluation: opt-in for the same reason (section 9); it runs
  // arbitrary code with the editor's authority over the project. --disable-eval
  // wins over the opt-in: enabling game eval never implies editor eval, and
  // disabling eval drops both (section 9).
  if (options.enableEditorEval && !options.disableEval) {
    registerEditorEvalTools(server, manager, timeouts);
  }
}

/** Addon install state tracked across the broker's lifetime, reported by gd_status. */
interface AddonStatus {
  detection: AddonDetection | null;
  lastInstallError: string | null;
  lastAttemptSource: string | null;
}

/**
 * Install the addon when the configured directory is a Godot project that has
 * none. Only the "missing" state auto-installs: "stale" and "unmanaged" both
 * imply a loaded extension and therefore a connected editor, which
 * gd_addon_install refuses anyway, so fixing them is an explicit call.
 */
async function autoInstall(config: Config, status: AddonStatus, events: EventRing): Promise<void> {
  if (!config.projectPath || status.detection?.state !== "missing" || !status.detection.projectValid) {
    return;
  }
  status.lastAttemptSource = config.addonSource;
  events.record("addon_install_started", { project_path: config.projectPath, version: VERSION });
  log(`installing the conduit addon v${VERSION} into ${config.projectPath}`);
  try {
    const result = await installAddon({
      projectPath: config.projectPath,
      version: VERSION,
      source: config.addonSource,
    });
    status.detection = detectAddon(config.projectPath, VERSION);
    status.lastInstallError = null;
    status.lastAttemptSource = result.source;
    log(`addon installed from ${result.source}; open the project in Godot so the extension loads`);
    events.record("addon_installed", {
      version: VERSION,
      source: result.source,
      autoload_added: result.autoloadAdded,
      files: result.files.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.lastInstallError = message;
    log(`addon install failed: ${message}`);
    events.record("addon_install_failed", { error: message });
  }
}

async function main(): Promise<void> {
  // Parsing lives inside main, not at module scope: broker/tests/tools.test.ts
  // imports registerTools from this file, and module-scope parsing would read
  // the test runner's argv and exit.
  const cli = runCli(process.argv, VERSION);
  if (cli.kind === "exit") {
    process.exit(cli.code);
  }
  // Before resolveConfig, which reads the variables these flags write.
  applyTransportEnv(cli.options);
  const config = resolveConfig(cli.options);

  const groups = parseToolGroups(config.toolGroups);
  const audit = config.auditLog ? new AuditLog(config.auditLog, config.auditMaxBytes, log) : null;
  const baseServer = new McpServer({ name: "conduit", version: VERSION });
  // Every registration path receives the wrapped server, so group filtering and
  // audit timing apply uniformly, including to the dynamic gd_project_* tools.
  const server = wrapServer(baseServer, { audit, groups });

  // Assigned after registerTools; the ring's notify closure runs only once
  // events start flowing, which is after main() finishes wiring.
  let projectTools: ProjectToolsRegistry | null = null;

  const events = new EventRing(256, (event) => {
    try {
      baseServer.server.sendLoggingMessage({ level: "info", logger: "conduit", data: event });
    } catch {
      // The client may not have enabled logging, or the transport is not up yet.
    }
    // Game lifecycle drives the dynamic gd_project_* surface (phase 9).
    if (projectTools) {
      if (event.type === "game_started") {
        projectTools.refreshFromGame().catch((error) => log(`project tool refresh failed: ${String(error)}`));
      } else if (event.type === "project_tools_changed") {
        const data = event.data as { tools?: ToolEntry[] };
        projectTools.sync(Array.isArray(data?.tools) ? data.tools : []);
      } else if (event.type === "game_exited") {
        projectTools.clear();
      }
    }
  });

  const manager = new BridgeManager({
    editorEndpoint: config.editorEndpoint,
    runtimeDir: config.runtimeDir,
    projectPath: config.projectPath,
    timeoutMs: config.timeouts.default,
    events,
  });

  // An absent editor is not fatal: gd_project_scaffold and gd_editor_launch
  // exist precisely for sessions that start before any editor does (section 8),
  // and the background reconnect adopts an editor whenever one appears.
  log(`connecting to editor bridge at ${endpointKey(config.editorEndpoint)}`);
  try {
    const hello = await manager.connectEditor();
    log(`connected to editor bridge (engine ${hello.engine_version})`);
  } catch {
    log(`editor bridge not available yet; continuing without it. ${manager.editorHint()}`);
  }
  manager.startEditorReconnect();
  manager.startGameDiscovery();

  // Detection is filesystem-only and cheap, so it runs before the transport is
  // up. Installing is not: it may reach the network, so it waits until after
  // server.connect below rather than delaying the MCP handshake.
  const addon: AddonStatus = {
    detection: config.projectPath ? detectAddon(config.projectPath, VERSION) : null,
    lastInstallError: null,
    lastAttemptSource: null,
  };
  if (addon.detection && !addon.detection.projectValid) {
    log(`${config.projectPath} has no project.godot, so it is not a Godot project`);
  } else if (addon.detection?.state === "missing") {
    log(
      config.autoInstall
        ? "the conduit addon is not installed in this project; installing it"
        : "the conduit addon is not installed in this project; set CONDUIT_AUTO_INSTALL=1 or call gd_addon_install to install it",
    );
  } else if (addon.detection?.state === "stale") {
    log(
      `the installed addon is v${addon.detection.installedVersion} but this broker is v${VERSION}; close the editor and call gd_addon_install to update it`,
    );
  } else if (addon.detection?.state === "unmanaged") {
    log("addons/conduit exists but was not installed by Conduit; leaving it alone");
  }

  registerTools(server, manager, events, {
    enablePixelTools: config.enablePixelTools,
    enableEditorEval: config.enableEditorEval,
    disableEval: config.disableEval,
    godot: config.godot,
    projectPath: config.projectPath,
    runtimeDir: config.runtimeDir,
    addonSource: config.addonSource,
    timeouts: config.timeouts,
    onInstallOutcome: ({ error, source }) => {
      addon.lastInstallError = error;
      addon.lastAttemptSource = source;
      if (config.projectPath) {
        addon.detection = detectAddon(config.projectPath, VERSION);
      }
    },
    extraStatus: () => {
      const engine = config.godot.resolve();
      return {
        engine: { binary: engine?.path ?? null, source: engine?.source ?? null },
        addon: {
          project_path: config.projectPath,
          project_valid: addon.detection?.projectValid ?? null,
          state: addon.detection?.state ?? null,
          installed_version: addon.detection?.installedVersion ?? null,
          expected_version: VERSION,
          autoload: addon.detection?.autoloadPresent ?? null,
          auto_install: config.autoInstall,
          last_install_error: addon.lastInstallError,
          last_attempt_source: addon.lastAttemptSource,
        },
      };
    },
  });
  // Project-defined tools execute project code, so they are eval-class and
  // disabled together with gd_game_eval (section 9).
  if (!config.disableEval) {
    projectTools = new ProjectToolsRegistry(server, manager, config.timeouts);
  }
  if (config.enablePixelTools) {
    log("pixel tools enabled (tier-3 editor fallback)");
  }
  if (config.enableEditorEval && !config.disableEval) {
    log("editor eval enabled (gd_editor_eval)");
  }
  if (config.disableEval) {
    log("eval-class tools disabled (gd_game_eval, gd_editor_eval, networking, project tools)");
  }
  if (groups) {
    log(`tool groups limited to: ${[...groups].sort().join(", ")}`);
  }
  if (audit?.enabled) {
    log(`auditing tool calls to ${audit.path}`);
  }

  const transport = new StdioServerTransport();
  await baseServer.connect(transport);
  log("MCP server ready on stdio");

  // After the handshake, so a slow or failing download never delays the client.
  // Progress reaches the agent through the event ring and gd_status.
  if (config.autoInstall) {
    void autoInstall(config, addon, events);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
