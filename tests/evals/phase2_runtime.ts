#!/usr/bin/env bun
// Phase 2 live acceptance runner (whitepaper section 10). It launches a real
// editor under a virtual display (Xvfb), so the editor-launched game renders and
// gd_screenshot captures a genuine frame, then drives the phase 2 acceptance
// criterion end to end through the broker via a real MCP client:
//
//   - launch the game and connect the game bridge (gd_play);
//   - read and set a node property with Variant typing;
//   - evaluate an expression that awaits a signal and returns a value;
//   - hold a movement action for a duration and observe the effect;
//   - capture a screenshot;
//   - pause and step the game a fixed number of frames;
//   - read back errors;
//   - stop the game and see a clean game_exited event.
//
// Run with `bun tests/evals/phase2_runtime.ts` (needs GODOT_BIN and a display:
// native on Windows/macOS, Xvfb on Linux -- the harness wraps it automatically).

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  endpointKey,
  godotCommand,
  killTree,
  repoRoot,
  requireDisplay,
  resolveGodot,
  runtimeDir,
  waitForEditor,
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p2");
const PLAYER = "/root/Main/Player";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

async function run(cmd: string[], cwd: string): Promise<number> {
  return Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
}

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callTool(client, name, args);
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  requireDisplay();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching editor with a display ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--editor", "--rendering-driver", "opengl3", "--path", "example-project"], true),
    { cwd: repoRoot, env: conduitEnv(RUNTIME_DIR), stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 120_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    record(
      "mcp_tools_listed",
      ["gd_play", "gd_node_set_property", "gd_game_eval", "gd_screenshot", "gd_get_events"].every((n) => names.includes(n)),
      `${names.length} tools exposed`,
    );

    await runChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 2 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 2 checks passed.");
}

async function runChecks(client: Client): Promise<void> {
  console.log("\nLaunching the game (gd_play) ...");
  const play = await callJson(client, "gd_play", {});
  record(
    "play_and_connect",
    play.playing === true && play.game_bridge_connected === true,
    `game launched and bridge connected (pid ${play.instance?.pid}, engine ${play.instance?.engine_version})`,
  );

  console.log("\nReading Player.position ...");
  const read = await callJson(client, "gd_node_get_property", { node_path: PLAYER, property: "position" });
  record(
    "read_property",
    read.value?.__type === "Vector2" && typeof read.value?.x === "number",
    `position = (${read.value?.x}, ${read.value?.y})`,
  );

  console.log("\nSetting Player.position and reading it back ...");
  await callJson(client, "gd_node_set_property", {
    node_path: PLAYER,
    property: "position",
    value: { __type: "Vector2", x: 123, y: 45 },
  });
  const after = await callJson(client, "gd_node_get_property", { node_path: PLAYER, property: "position" });
  record(
    "set_property",
    Math.abs((after.value?.x ?? 0) - 123) < 0.5 && Math.abs((after.value?.y ?? 0) - 45) < 0.5,
    `position read back as (${after.value?.x}, ${after.value?.y})`,
  );

  console.log("\nEvaluating an expression that awaits a signal ...");
  const evaluated = await callJson(client, "gd_game_eval", { source: `return await get_node("${PLAYER}").pinged` });
  record(
    "eval_await_signal",
    evaluated.value === 42,
    `gd_game_eval awaited the pinged signal and returned ${JSON.stringify(evaluated.value)}`,
  );

  console.log("\nHolding move_right for a duration ...");
  const before = await callJson(client, "gd_node_get_property", { node_path: PLAYER, property: "position" });
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: true });
  await callJson(client, "gd_wait_frames", { frames: 30 });
  const moved = await callJson(client, "gd_node_get_property", { node_path: PLAYER, property: "position" });
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: false });
  record(
    "hold_input_moves",
    (moved.value?.x ?? 0) > (before.value?.x ?? 0) + 10,
    `x advanced from ${before.value?.x} to ${moved.value?.x} while the action was held`,
  );

  console.log("\nCapturing a screenshot ...");
  try {
    const shot = await callTool(client, "gd_screenshot", { max_dimension: 320 });
    const image = shot.content.find((c) => c.type === "image");
    record(
      "screenshot",
      !shot.isError && !!image && (image.data?.length ?? 0) > 100,
      image ? `captured ${image.mimeType}, ${image.data?.length} base64 chars` : `no image content: ${shot.content[0]?.text}`,
    );
  } catch (error) {
    record("screenshot", false, String(error));
  }

  console.log("\nPausing and stepping frames ...");
  await callJson(client, "gd_pause", { paused: true });
  const stepped = await callJson(client, "gd_step_frames", { frames: 5 });
  record("pause_step", stepped.stepped_frames === 5, `stepped ${stepped.stepped_frames} frames while paused`);
  await callJson(client, "gd_pause", { paused: false });

  console.log("\nReading back errors ...");
  const errors = await callJson(client, "gd_get_errors", {});
  record("read_errors", Array.isArray(errors.errors), `gd_get_errors returned ${errors.errors?.length ?? "?"} error line(s)`);

  console.log("\nStopping the game and checking for a game_exited event ...");
  const eventsBefore = await callJson(client, "gd_get_events", {});
  await callJson(client, "gd_stop", {});
  let exited = false;
  for (let i = 0; i < 25 && !exited; i++) {
    await sleep(200);
    const events = await callJson(client, "gd_get_events", { cursor: eventsBefore.next_cursor });
    exited = (events.events ?? []).some((e: { type: string }) => e.type === "game_exited");
  }
  record("game_exited_event", exited, exited ? "broker reported a clean game_exited event" : "no game_exited event observed");
}

async function connectBroker(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase2-acceptance", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
