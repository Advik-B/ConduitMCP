// The demo scenario: one continuous agent session against a live editor,
// divided into chapters that each make a single claim about what Conduit can
// do. Every call announces itself in the recording's caption before it fires,
// and chapters pause between steps so the editor's own repaint is legible at
// video frame rates rather than flashing past.
//
// The scenario is deliberately scripted rather than model-driven: the README
// video has to be reproducible from a checkout, and a real agent session would
// differ every take.

import { setTimeout as sleep } from "node:timers/promises";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Recorder } from "./capture.ts";

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
}
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** Beat between calls, so a viewer can follow what changed. */
const BEAT_MS = 700;

const LEVEL_PATH = "res://level.tscn";
const COIN_SCRIPT = "res://coin.gd";
const TOOLS_SCRIPT = "res://level_tools.gd";
const PLAYER_SCRIPT = "res://player.gd";
const BREAKPOINT_LINE = 24;

/** Broker tools that share the gd_project_ prefix without being project-defined;
 * the tools chapter claims the rest come from the game, so it must exclude these. */
const STATIC_PROJECT_TOOLS = new Set([
  "gd_project_scaffold",
  "gd_project_get_setting",
  "gd_project_set_setting",
  "gd_project_call",
  "gd_project_tools_list",
]);

const COIN_SOURCE = `extends ColorRect

# Written by the agent through gd_script_create, checked with gd_script_validate,
# and attached with gd_script_attach, all without touching the filesystem
# behind the editor's back.

const BOB_HEIGHT := 10.0
const BOB_SPEED := 3.0

var _origin := 0.0
var _phase := 0.0


func _ready() -> void:
	_origin = position.y
	_phase = position.x * 0.02


func _process(delta: float) -> void:
	_phase += delta * BOB_SPEED
	position.y = _origin + sin(_phase) * BOB_HEIGHT
`;

const TOOLS_SOURCE = `extends Node

# A node in the conduit_tools group. Every public method here becomes a
# first-class MCP tool the moment the game connects: spawn_coins turns up on
# the agent's tool list as gd_project_spawn_coins, with a typed schema derived
# from this signature.

var spawned := 0


func spawn_coins(count: int) -> int:
	var level := get_parent()
	for i in range(count):
		var coin := ColorRect.new()
		coin.size = Vector2(18, 18)
		coin.color = Color(0.95, 0.8, 0.25)
		coin.position = Vector2(140.0 + i * 90.0, 240.0)
		coin.set_script(load("res://coin.gd"))
		level.add_child(coin)
		spawned += 1
	return spawned


func level_bounds() -> Vector2:
	return Vector2(860, 390)
`;

export class Scenario {
  constructor(
    private readonly client: Client,
    private readonly rec: Recorder,
  ) {}

  async run(): Promise<void> {
    await this.buildLevel();
    await this.writeScript();
    await this.wireItUp();
    await this.undoRedo();
    await this.playIt();
    await this.projectTools();
    await this.debugIt();
    await this.showResult();
  }

  // Chapter 1: a scene that did not exist, built node by node through the
  // editor's own scene API.
  private async buildLevel(): Promise<void> {
    this.rec.chapter("Building a scene through the editor's own API", true);
    await this.call("gd_scene_create", { root_type: "Node2D", root_name: "Level", path: LEVEL_PATH, open: true });
    await this.call("gd_editor_set_main_screen", { name: "2D" });

    // Level geometry is sized to fit the 2D viewport at the editor's default
    // 100% zoom, so the whole level stays in frame without the recorder having
    // to drive the viewport's zoom controls.
    await this.rect("Sky", 0, 0, 860, 390, 0.06, 0.07, 0.13);
    await this.rect("Ground", 0, 330, 860, 60, 0.13, 0.3, 0.22);
    await this.rect("Platform1", 200, 250, 130, 18, 0.22, 0.45, 0.32);
    await this.rect("Platform2", 400, 190, 130, 18, 0.22, 0.45, 0.32);
    await this.rect("Platform3", 610, 130, 130, 18, 0.22, 0.45, 0.32);
    await this.rect("Coin1", 255, 216, 16, 16, 0.95, 0.8, 0.25);
    await this.rect("Coin2", 455, 156, 16, 16, 0.95, 0.8, 0.25);
    await this.rect("Coin3", 665, 96, 16, 16, 0.95, 0.8, 0.25);
    await this.rect("Door", 790, 270, 32, 60, 0.55, 0.35, 0.75);

    await this.call("gd_node_add", {
      parent_path: ".",
      type: "Node2D",
      name: "Player",
      properties: { position: v2(90, 294) },
    });
    await this.call("gd_node_add", {
      parent_path: "Player",
      type: "ColorRect",
      name: "Body",
      properties: { size: v2(28, 36), color: color(0.95, 0.55, 0.25) },
    });
    await this.call("gd_node_add", {
      parent_path: ".",
      type: "Label",
      name: "Title",
      properties: { position: v2(20, 14), text: "LEVEL 01", "theme_override_font_sizes/font_size": 26 },
    });
    await this.call("gd_node_add", {
      parent_path: ".",
      type: "Camera2D",
      name: "Camera",
      properties: { position: v2(430, 195) },
    });

    // Select and inspect so the scene dock and the inspector follow along; a
    // human watching the editor can see exactly which node the agent means.
    await this.call("gd_editor_select", { op: "set", node_paths: ["Player"] });
    await this.call("gd_editor_inspect", { node_path: "Player" });
    await sleep(1_200);
  }

  // Chapter 2: the agent writes GDScript, proves it compiles, and attaches it.
  private async writeScript(): Promise<void> {
    this.rec.chapter("Writing a script, checking it compiles, attaching it", true);
    await this.call("gd_script_create", { path: COIN_SCRIPT, template_source: COIN_SOURCE }, "gd_script_create res://coin.gd");
    const validated = await this.call("gd_script_validate", { path: COIN_SCRIPT });
    console.log(`  coin.gd valid: ${validated.valid}`);
    for (const coin of ["Coin1", "Coin2", "Coin3"]) {
      await this.call("gd_script_attach", { node_path: coin, script_path: COIN_SCRIPT });
    }
    await this.call("gd_script_attach", { node_path: "Player", script_path: PLAYER_SCRIPT });
    this.rec.highlightFrom();
    await this.call("gd_editor_open_script", { path: COIN_SCRIPT, line: 18 });
    await sleep(3_000);
    await this.call("gd_editor_set_main_screen", { name: "2D" });
    await sleep(800);
  }

  // Chapter 3: the wiring a scene needs to be a game, all persisted.
  private async wireItUp(): Promise<void> {
    this.rec.chapter("Signals, groups, the input map, and a saved scene");
    await this.call("gd_script_create", { path: TOOLS_SCRIPT, template_source: TOOLS_SOURCE }, "gd_script_create res://level_tools.gd");
    await this.call("gd_node_add", { parent_path: ".", type: "Node", name: "Tools" });
    await this.call("gd_script_attach", { node_path: "Tools", script_path: TOOLS_SCRIPT });
    await this.call("gd_node_group", { op: "add", node_path: "Tools", group: "conduit_tools" });
    for (const coin of ["Coin1", "Coin2", "Coin3"]) {
      await this.call("gd_node_group", { op: "add", node_path: coin, group: "coins" });
    }
    await this.call("gd_scene_signal", { op: "connect", node_path: "Player", signal: "pinged", target_path: "Tools", method: "_on_player_pinged" });
    await this.call("gd_input_map", { op: "add_event", action: "move_right", event: { type: "key", key: "right" } });
    await this.call("gd_scene_save", {});
    await sleep(1_200);
  }

  // Chapter 4: the claim that separates this from writing .tscn files. Every
  // edit above went through the editor's undo history, so it comes apart the
  // way a human's work does, and goes back together the same way.
  private async undoRedo(): Promise<void> {
    this.rec.chapter("Every edit is in the editor's own undo history", true);
    await this.call("gd_editor_select", { op: "clear" });
    this.rec.highlightFrom();
    let undone = 0;
    for (let i = 0; i < 30; i++) {
      const result = await this.call("gd_undo", {}, `gd_undo (${i + 1})`, 260);
      if (result.performed === false) {
        break;
      }
      undone++;
    }
    console.log(`  undone: ${undone} actions`);
    await sleep(1_500);
    this.rec.caption("the level is gone; now put it back");
    await sleep(1_500);
    for (let i = 0; i < undone; i++) {
      await this.call("gd_redo", {}, `gd_redo (${i + 1})`, 180);
    }
    await this.call("gd_scene_save", {});
    await sleep(1_500);
  }

  // Chapter 5: the game the agent just built, running, driven by the agent.
  private async playIt(): Promise<void> {
    this.rec.chapter("Running the game and driving it with simulated input", true);
    const play = await this.call("gd_play", { scene: LEVEL_PATH }, "gd_play res://level.tscn", 2_500);
    if (play.game_bridge_connected !== true) {
      throw new Error("game bridge did not connect");
    }
    this.rec.highlightFrom();
    await this.call("gd_input", { device: "action", action: "move_right", pressed: true });
    await this.call("gd_wait_frames", { frames: 60 });
    const position = await this.call("gd_node_get_property", { node_path: "/root/Level/Player", property: "position" });
    console.log(`  player position: ${JSON.stringify(position.value)}`);
    this.rec.caption(`gd_node_get_property -> position ${formatVector(position.value)}`);
    await sleep(1_500);
    await this.call("gd_set_time_scale", { scale: 0.35 });
    await this.call("gd_wait_frames", { frames: 40 });
    await this.call("gd_set_time_scale", { scale: 1.0 });
    await this.call("gd_input", { device: "action", action: "move_right", pressed: false });
    await this.call("gd_screenshot", {}, "gd_screenshot (the game's own rendered frame)");
    await sleep(1_200);
  }

  // Chapter 6: the project teaching the agent its own verbs.
  private async projectTools(): Promise<void> {
    this.rec.chapter("The project's own methods, surfaced as MCP tools", true);
    // The broker registers a tool per conduit_tools method when the game
    // connects, so the proof is in the MCP tool list itself, not in a call.
    this.rec.caption("tools/list -> the game's own verbs are on the agent's tool list");
    const names = (await this.client.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("gd_project_") && !STATIC_PROJECT_TOOLS.has(name));
    console.log(`  project tools: ${names.join(", ")}`);
    if (names.length > 0) {
      this.rec.caption(`tools/list -> ${names.join(", ")}`);
    }
    await sleep(3_000);
    this.rec.highlightFrom();
    await this.call("gd_project_spawn_coins", { count: 6 }, "gd_project_spawn_coins {count: 6}", 2_000);
    await this.call("gd_wait_frames", { frames: 30 });
    await sleep(1_500);
  }

  // Chapter 7: a breakpoint in the running game, hit by the agent's own input,
  // read through the editor's debugger.
  private async debugIt(): Promise<void> {
    this.rec.chapter("A breakpoint, tripped by the agent, read in the editor", true);
    await this.call("gd_debug", { op: "set_breakpoint", path: PLAYER_SCRIPT, line: BREAKPOINT_LINE });
    await this.call("gd_editor_open_script", { path: PLAYER_SCRIPT, line: BREAKPOINT_LINE });
    await this.call("gd_input", { device: "action", action: "move_right", pressed: true }, "gd_input move_right (trips the breakpoint)");

    let breaked = false;
    for (let i = 0; i < 90 && !breaked; i++) {
      const status = await this.callQuiet("gd_status", {});
      breaked = status.debug?.breaked === true;
      if (!breaked) await sleep(200);
    }
    if (!breaked) {
      throw new Error("breakpoint did not hit within 18 s");
    }
    this.rec.highlightFrom();
    this.rec.caption("game halted; the editor is showing the stack and locals");
    await sleep(2_500);

    const stack = await this.call("gd_debug", { op: "stack" }, "gd_debug op=stack", 1_500);
    const top = stack.frames?.[0];
    if (top) {
      this.rec.caption(`gd_debug op=stack -> ${top.function} at ${top.file}:${top.line}`);
      await sleep(2_000);
    }
    const vars = await this.call("gd_debug", { op: "vars", frame: 0 }, "gd_debug op=vars frame=0", 1_500);
    console.log(`  frame variables: ${Object.keys(vars.variables ?? vars.locals ?? {}).join(", ")}`);
    await sleep(2_000);
    await this.call("gd_debug", { op: "step_over" }, "gd_debug op=step_over", 1_500);
    await this.call("gd_debug", { op: "clear_breakpoint", all: true });
    await this.call("gd_debug", { op: "continue" });
    await this.call("gd_input", { device: "action", action: "move_right", pressed: false });
    await sleep(1_200);
    await this.call("gd_stop", {});
    await sleep(1_500);
  }

  // Chapter 8: what the developer is left holding. Not a private format the
  // agent can read back, but an ordinary scene and ordinary scripts, sitting in
  // the project where a human would have put them.
  private async showResult(): Promise<void> {
    this.rec.chapter("What is left behind is an ordinary Godot project", true);
    await this.call("gd_editor_set_main_screen", { name: "2D" });
    await this.call("gd_scene_open", { path: LEVEL_PATH });
    this.rec.highlightFrom();
    await this.call("gd_editor_select", {
      op: "set",
      node_paths: ["Sky", "Ground", "Platform1", "Platform2", "Platform3", "Coin1", "Coin2", "Coin3", "Door", "Player", "Title", "Camera", "Tools"],
    });
    await sleep(2_500);
    this.rec.caption("res://level.tscn, res://coin.gd, res://level_tools.gd: normal project files");
    await sleep(3_000);
    await this.call("gd_editor_select", { op: "set", node_paths: ["Player"] });
    await this.call("gd_editor_inspect", { node_path: "Player" });
    this.rec.caption("every node, script, signal, and group above came from an MCP tool call");
    await sleep(5_000);
  }

  private async rect(
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
  ): Promise<void> {
    await this.call(
      "gd_node_add",
      {
        parent_path: ".",
        type: "ColorRect",
        name,
        properties: { position: v2(x, y), size: v2(w, h), color: color(r, g, b) },
      },
      `gd_node_add ColorRect ${name}`,
      450,
    );
  }

  /** Caption the call, make it, then hold for a beat so the change is visible. */
  private async call(
    name: string,
    args: Record<string, unknown>,
    caption?: string,
    beatMs: number = BEAT_MS,
  ): Promise<any> {
    this.rec.caption(caption ?? summarise(name, args));
    const parsed = await this.callQuiet(name, args);
    await sleep(beatMs);
    return parsed;
  }

  private async callQuiet(name: string, args: Record<string, unknown>): Promise<any> {
    const result = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    if (result.isError) {
      throw new Error(`${name} failed: ${text}`);
    }
    // Image results (gd_screenshot) carry no text payload worth parsing.
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

function v2(x: number, y: number): Record<string, unknown> {
  return { __type: "Vector2", x, y };
}

function color(r: number, g: number, b: number): Record<string, unknown> {
  return { __type: "Color", r, g, b, a: 1 };
}

function formatVector(value: unknown): string {
  const v = value as { x?: number; y?: number } | undefined;
  if (typeof v?.x !== "number" || typeof v?.y !== "number") {
    return String(value);
  }
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`;
}

/** A one-line rendering of a call for the caption bar; long argument objects
 * are dropped rather than wrapped, since the bar is a single line. */
function summarise(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || typeof value === "object") continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (parts.length === 3) break;
  }
  return parts.length > 0 ? `${name} ${parts.join(" ")}` : name;
}
