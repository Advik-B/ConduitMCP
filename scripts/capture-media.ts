#!/usr/bin/env bun
// Regenerate the README screenshots in docs/media/ by driving a real editor
// session through the broker, using the phase-eval launch recipe. Needs a
// display: native on Windows/macOS, Xvfb on Linux. Nothing is saved to the
// example project; the editor is killed with its unsaved changes discarded.
// Run with `bun scripts/capture-media.ts`.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  exampleProject,
  godotCommand,
  killTree,
  repoRoot,
  requireDisplay,
  resolveGodot,
  runtimeDir,
  waitForEditor,
} from "../tests/evals/harness.ts";

const RUNTIME_DIR = runtimeDir("media");
const MEDIA_DIR = join(repoRoot, "docs", "media");

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

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
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

async function saveShot(client: Client, tool: "gd_editor_screenshot" | "gd_screenshot", file: string, maxDimension?: number): Promise<void> {
  const args: Record<string, unknown> = maxDimension ? { max_dimension: maxDimension } : {};
  const result = await callTool(client, tool, args);
  const image = result.content.find((c) => c.type === "image");
  if (result.isError || !image?.data) {
    throw new Error(`${tool} failed: ${result.content[0]?.text ?? "no image"}`);
  }
  writeFileSync(join(MEDIA_DIR, file), Buffer.from(image.data, "base64"));
  console.log(`saved docs/media/${file}`);
}

// The game shot: a small scene assembled at runtime inside the running game,
// attached to the input-driven Player node so simulated input moves it.
const GAME_SCENE_EVAL = `
var root = get_tree().current_scene
var sky = ColorRect.new()
sky.color = Color(0.05, 0.06, 0.12)
sky.size = Vector2(1200, 700)
sky.z_index = -10
root.add_child(sky)
var rng = RandomNumberGenerator.new()
rng.seed = 7
for i in range(90):
	var star = ColorRect.new()
	var s = rng.randf_range(1.5, 3.5)
	star.size = Vector2(s, s)
	star.position = Vector2(rng.randf_range(0.0, 1152.0), rng.randf_range(0.0, 560.0))
	star.color = Color(1, 1, 1, rng.randf_range(0.3, 1.0))
	sky.add_child(star)
var pts = PackedVector2Array()
for i in range(24):
	var a = TAU * i / 24.0
	pts.append(Vector2(cos(a), sin(a)) * 70.0)
var planet = Polygon2D.new()
planet.polygon = pts
planet.color = Color(0.85, 0.45, 0.3)
planet.position = Vector2(960, 140)
root.add_child(planet)
var ground = ColorRect.new()
ground.color = Color(0.1, 0.12, 0.2)
ground.size = Vector2(1200, 100)
ground.position = Vector2(0, 560)
root.add_child(ground)
var player = get_node("/root/Main/Player")
player.position = Vector2(420, 470)
var ship = Polygon2D.new()
ship.polygon = PackedVector2Array([Vector2(0, -26), Vector2(18, 16), Vector2(7, 9), Vector2(-7, 9), Vector2(-18, 16)])
ship.color = Color(0.55, 0.85, 1.0)
player.add_child(ship)
var exhaust = CPUParticles2D.new()
exhaust.position = Vector2(0, 14)
exhaust.amount = 40
exhaust.lifetime = 0.5
exhaust.direction = Vector2(0, 1)
exhaust.spread = 20.0
exhaust.initial_velocity_min = 60.0
exhaust.initial_velocity_max = 140.0
exhaust.scale_amount_min = 2.0
exhaust.scale_amount_max = 4.0
exhaust.color = Color(1.0, 0.6, 0.2)
player.add_child(exhaust)
var title = Label.new()
title.text = "scene assembled at runtime by gd_game_eval"
title.position = Vector2(24, 20)
title.add_theme_font_size_override("font_size", 26)
root.add_child(title)
var hint = Label.new()
hint.text = "ship moves under gd_input (action: move_right)"
hint.position = Vector2(24, 56)
hint.modulate = Color(1, 1, 1, 0.7)
hint.add_theme_font_size_override("font_size", 18)
root.add_child(hint)
return "ok"
`;

async function captureGameShot(client: Client): Promise<void> {
  console.log("game shot: launching the game ...");
  const play = await callJson(client, "gd_play", {});
  if (play.game_bridge_connected !== true) {
    throw new Error("game bridge did not connect");
  }
  const built = await callJson(client, "gd_game_eval", { source: GAME_SCENE_EVAL });
  if (built.value !== "ok") {
    throw new Error(`scene eval returned ${JSON.stringify(built.value)}`);
  }
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: true });
  await callJson(client, "gd_wait_frames", { frames: 45 });
  await saveShot(client, "gd_screenshot", "game-screenshot.png");
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: false });
  await callJson(client, "gd_stop", {});
  await sleep(1_000);
}

async function captureDebuggerShot(client: Client): Promise<void> {
  console.log("debugger shot: setting a breakpoint and triggering it ...");
  await callJson(client, "gd_editor_open_script", { path: "res://player.gd", line: 24 });
  await callJson(client, "gd_debug", { op: "set_breakpoint", path: "res://player.gd", line: 24 });
  await callJson(client, "gd_play", {});
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: true });
  let breaked = false;
  for (let i = 0; i < 75 && !breaked; i++) {
    const status = await callJson(client, "gd_status", {});
    breaked = status.debug?.breaked === true;
    if (!breaked) await sleep(200);
  }
  if (!breaked) {
    throw new Error("breakpoint did not hit");
  }
  await sleep(1_500);
  await saveShot(client, "gd_editor_screenshot", "debugger-break.png", 1600);
  await callJson(client, "gd_debug", { op: "clear_breakpoint", all: true });
  await callJson(client, "gd_debug", { op: "continue" });
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: false });
  await callJson(client, "gd_stop", {});
  await sleep(1_000);
}

// The editor shot: build a level in the open scene through the undo-wrapped
// editing tools, then screenshot the editor. Never saved; discarded on exit.
async function captureEditorShot(client: Client): Promise<void> {
  console.log("editor shot: building a scene through the editing tools ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  await callJson(client, "gd_editor_set_main_screen", { name: "2D" });
  const rect = async (name: string, x: number, y: number, w: number, h: number, r: number, g: number, b: number) => {
    await callJson(client, "gd_node_add", {
      parent_path: ".",
      type: "ColorRect",
      name,
      properties: {
        position: { __type: "Vector2", x, y },
        size: { __type: "Vector2", x: w, y: h },
        color: { __type: "Color", r, g, b, a: 1 },
      },
    });
  };
  await rect("Sky", 0, 0, 1152, 648, 0.06, 0.07, 0.13);
  await rect("Ground", 0, 520, 1152, 128, 0.13, 0.3, 0.22);
  await rect("Platform1", 300, 400, 160, 24, 0.22, 0.45, 0.32);
  await rect("Platform2", 560, 320, 160, 24, 0.22, 0.45, 0.32);
  await rect("Platform3", 820, 240, 160, 24, 0.22, 0.45, 0.32);
  await rect("Coin1", 370, 360, 18, 18, 0.95, 0.8, 0.25);
  await rect("Coin2", 630, 280, 18, 18, 0.95, 0.8, 0.25);
  await rect("Coin3", 890, 200, 18, 18, 0.95, 0.8, 0.25);
  await rect("Hero", 150, 480, 40, 40, 0.95, 0.55, 0.25);
  await rect("Door", 1060, 456, 40, 64, 0.55, 0.35, 0.75);
  await callJson(client, "gd_node_add", {
    parent_path: ".",
    type: "Label",
    name: "Title",
    properties: {
      position: { __type: "Vector2", x: 24, y: 20 },
      text: "LEVEL 01",
      "theme_override_font_sizes/font_size": 32,
    },
  });
  await callJson(client, "gd_node_add", {
    parent_path: ".",
    type: "CPUParticles2D",
    name: "Dust",
    properties: { position: { __type: "Vector2", x: 576, y: 300 }, amount: 48 },
  });
  await callJson(client, "gd_node_add", {
    parent_path: ".",
    type: "Camera2D",
    name: "Camera",
    properties: { position: { __type: "Vector2", x: 576, y: 324 } },
  });
  await callJson(client, "gd_editor_select", { op: "set", node_paths: ["Hero"] });
  await callJson(client, "gd_editor_inspect", { node_path: "Hero" });
  await sleep(1_500);
  await saveShot(client, "gd_editor_screenshot", "editor-agent-scene.png", 1600);
}

// Each capture group runs in a fresh editor so leftover panels and toasts from
// an earlier group do not appear in later shots. The gdext editor-placeholder
// warning is suppressed so its toast stays out of frame.
async function withEditorSession(godot: string, fn: (client: Client) => Promise<void>): Promise<void> {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const env = conduitEnv(RUNTIME_DIR, { GDRUST_SUPPRESSED_WARNINGS: "EditorPlaceholderV06" });

  console.log("launching editor ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--editor", "--rendering-driver", "opengl3", "--path", "example-project"], true),
    { cwd: repoRoot, env, stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    await waitForEditor(RUNTIME_DIR, 120_000);
    const transport = new StdioClientTransport({
      command: "bun",
      args: [join(repoRoot, "broker", "src", "index.ts")],
      env,
    });
    client = new Client({ name: "capture-media", version: "0.3.0" });
    await client.connect(transport);
    await sleep(6_000);
    await fn(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  requireDisplay();
  mkdirSync(MEDIA_DIR, { recursive: true });
  await withEditorSession(godot, async (client) => {
    await captureGameShot(client);
    await captureDebuggerShot(client);
  });
  // Drop the cached editor layout so the second session opens with the default
  // layout: no bottom panel over the viewport, no restored scene tabs.
  rmSync(join(exampleProject, ".godot", "editor"), { recursive: true, force: true });
  await withEditorSession(godot, captureEditorShot);
  console.log("done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
