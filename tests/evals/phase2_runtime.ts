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
// Run with `bun tests/evals/phase2_runtime.ts` (needs xvfb-run and GODOT_BIN).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
// Short paths: a Unix domain socket path must fit sun_path (~108 bytes).
const SOCK_DIR = "/tmp/conduit-p2";
const EDITOR_SOCK = join(SOCK_DIR, "editor.sock");
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

function resolveGodot(): string {
  const env = process.env.GODOT_BIN;
  if (env && existsSync(env)) {
    return env;
  }
  const pointer = join(repoRoot, "tools", "godot", "GODOT_BIN");
  if (existsSync(pointer)) {
    const path = readFileSync(pointer, "utf8").trim();
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("GODOT_BIN not set and tools/godot/GODOT_BIN missing; run `bun scripts/setup.ts`");
}

function requireXvfb(): void {
  const found = Bun.spawnSync(["which", "xvfb-run"]).exitCode === 0;
  if (!found) {
    throw new Error("xvfb-run not found; run `bun scripts/setup.ts` to install it (needs apt)");
  }
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
  requireXvfb();
  console.log(`Godot: ${godot}`);
  console.log(`Socket dir: ${SOCK_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(SOCK_DIR, { recursive: true, force: true });
  mkdirSync(SOCK_DIR, { recursive: true });

  console.log("\nLaunching editor under Xvfb ...");
  const editorEnv = {
    ...process.env,
    CONDUIT_SOCK: EDITOR_SOCK,
    CONDUIT_RUNTIME_DIR: SOCK_DIR,
    CONDUIT_ENABLE: "1",
  } as Record<string, string>;
  const editor = Bun.spawn(
    [
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1280x720x24",
      godot,
      "--editor",
      "--rendering-driver",
      "opengl3",
      "--path",
      "example-project",
    ],
    { cwd: repoRoot, env: editorEnv, stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    await waitForSocket(EDITOR_SOCK, 120_000);
    record("editor_bound", existsSync(EDITOR_SOCK), `editor bridge socket present at ${EDITOR_SOCK}`);

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
    editor.kill();
    Bun.spawnSync(["pkill", "-f", "example-project"]);
    await editor.exited.catch(() => {});
    rmSync(SOCK_DIR, { recursive: true, force: true });
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
    env: { ...process.env, CONDUIT_SOCK: EDITOR_SOCK, CONDUIT_RUNTIME_DIR: SOCK_DIR } as Record<string, string>,
  });
  const client = new Client({ name: "phase2-acceptance", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`editor bridge socket did not appear within ${timeoutMs} ms`);
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
