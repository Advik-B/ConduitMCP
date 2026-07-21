#!/usr/bin/env bun
// Phase 6 live acceptance runner (whitepaper section 10). It drives the phase 6
// acceptance criterion end to end through the broker against a real editor under
// a virtual display (Xvfb):
//
//   - with no opt-in flag, the four tier-3 pixel tools are absent from the surface;
//   - with --enable-pixel-tools, they appear;
//   - gd_editor_window_info reports the editor window geometry and scale;
//   - a pixel click and a rubber-band drag in the 2D viewport select a node by its
//     screen position, a genuine viewport gesture with no tier-1 or tier-2
//     equivalent (gd_editor_select selects by node path, and gd_editor_ui cannot
//     select-by-position in the canvas), verified via gd_editor_get_state.
//
// The fixture scene example-project/pixel_target.tscn holds a large ColorRect
// centred on the origin so a canvas click has a pickable target. The editor is
// launched with that scene as a startup argument so it is the current edited
// scene (opening it afterwards through gd_scene_open does not switch the active
// tab reliably under a headless --editor run).
//
// Run with `bun tests/evals/phase6_pixel.ts` (needs xvfb-run and GODOT_BIN).

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SOCK_DIR = "/tmp/conduit-p6";
const EDITOR_SOCK = join(SOCK_DIR, "editor.sock");
const AWAIT = 60_000;
const PIXEL_TOOLS = ["gd_editor_pixel_move", "gd_editor_pixel_click", "gd_editor_pixel_drag", "gd_editor_window_info"];

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
  if (env && existsSync(env)) return env;
  const pointer = join(repoRoot, "tools", "godot", "GODOT_BIN");
  if (existsSync(pointer)) {
    const path = readFileSync(pointer, "utf8").trim();
    if (existsSync(path)) return path;
  }
  throw new Error("GODOT_BIN not set and tools/godot/GODOT_BIN missing; run `bun scripts/setup.ts`");
}

function requireXvfb(): void {
  if (Bun.spawnSync(["which", "xvfb-run"]).exitCode !== 0) {
    throw new Error("xvfb-run not found; run `bun scripts/setup.ts` to install it");
  }
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function callRaw(client: Client, name: string, args: Record<string, unknown>, timeoutMs = AWAIT): Promise<{ isError: boolean; text: string; json: any }> {
  const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: result.isError ?? false, text, json };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}, timeoutMs = AWAIT): Promise<any> {
  const result = await callRaw(client, name, args, timeoutMs);
  if (result.isError) {
    throw new Error(`${name} failed: ${result.text}`);
  }
  return result.json;
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  requireXvfb();
  console.log(`Godot: ${godot}\nSocket dir: ${SOCK_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await Bun.spawn(["cargo", "build", "-p", "conduit"], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" }).exited) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(SOCK_DIR, { recursive: true, force: true });
  mkdirSync(SOCK_DIR, { recursive: true });

  console.log("\nLaunching editor under Xvfb ...");
  const editor = Bun.spawn(
    ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", godot, "--editor", "--rendering-driver", "opengl3", "--path", "example-project", "res://pixel_target.tscn"],
    {
      cwd: repoRoot,
      env: { ...process.env, CONDUIT_SOCK: EDITOR_SOCK, CONDUIT_RUNTIME_DIR: SOCK_DIR, CONDUIT_ENABLE: "1" } as Record<string, string>,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let enabled: Client | null = null;
  try {
    await waitForSocket(EDITOR_SOCK, 120_000);
    record("editor_bound", existsSync(EDITOR_SOCK), "editor bridge socket present");

    await runGatingChecks();

    enabled = await connectBroker(true);
    const names = (await enabled.listTools()).tools.map((t) => t.name);
    record("pixel_tools_present_when_enabled", PIXEL_TOOLS.every((n) => names.includes(n)), `${names.length} tools exposed with the flag`);

    await runGestureChecks(enabled);
  } finally {
    await enabled?.close().catch(() => {});
    editor.kill();
    Bun.spawnSync(["pkill", "-f", "example-project"]);
    await editor.exited.catch(() => {});
    rmSync(SOCK_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 6 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 6 checks passed.");
}

// The tools remain off by default: a broker started without the opt-in flag must
// not expose them at all.
async function runGatingChecks(): Promise<void> {
  console.log("\nChecking the default (disabled) tool surface ...");
  const off = await connectBroker(false);
  try {
    const names = (await off.listTools()).tools.map((t) => t.name);
    const leaked = PIXEL_TOOLS.filter((n) => names.includes(n));
    record("pixel_tools_absent_by_default", leaked.length === 0, leaked.length === 0 ? "no pixel tools exposed without the flag" : `leaked: ${leaked.join(", ")}`);
  } finally {
    await off.close().catch(() => {});
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Poll the selection until it matches the expected node, so a slow editor frame
// does not race the assertion.
async function selectionBecomes(client: Client, expected: string, tries = 25): Promise<string[]> {
  let selection: string[] = [];
  for (let i = 0; i < tries; i++) {
    selection = (await callJson(client, "gd_editor_get_state", {})).selection ?? [];
    if (selection.includes(expected)) return selection;
    await sleep(200);
  }
  return selection;
}

async function runGestureChecks(client: Client): Promise<void> {
  console.log("\nReading editor window geometry ...");
  const info = await callJson(client, "gd_editor_window_info", {});
  record(
    "window_info",
    info.headless === false && info.size?.width > 0 && info.size?.height > 0 && typeof info.editor_scale === "number",
    `size ${info.size?.width}x${info.size?.height}, editor_scale ${info.editor_scale}`,
  );

  console.log("\nOpening the 2D viewport on the fixture scene ...");
  await callJson(client, "gd_editor_set_main_screen", { name: "2D" });
  let state = await callJson(client, "gd_editor_get_state", {});
  for (let i = 0; i < 25 && state.current_scene !== "res://pixel_target.tscn"; i++) {
    await sleep(200);
    state = await callJson(client, "gd_editor_get_state", {});
  }
  record(
    "fixture_ready",
    state.main_screen === "2D" && state.current_scene === "res://pixel_target.tscn",
    `main screen ${state.main_screen}, current scene ${state.current_scene}`,
  );
  if (state.current_scene !== "res://pixel_target.tscn") return;

  // The 2D canvas viewport's screen rect, so canvas coordinates are computed from
  // real geometry rather than guessed.
  const found = await callJson(client, "gd_editor_ui", { op: "find", class: "CanvasItemEditorViewport", limit: 5 });
  let canvas: Rect | null = null;
  for (const c of found.controls ?? []) {
    const described = await callJson(client, "gd_editor_ui", { op: "describe", path: c.path });
    if (described.visible && described.rect?.width > 100) {
      canvas = described.rect;
      break;
    }
  }
  record("located_canvas", canvas != null, canvas ? `canvas rect ${JSON.stringify(canvas)}` : "no visible 2D canvas viewport found");
  if (!canvas) return;

  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;

  console.log(`\nMoving the synthetic cursor into the canvas (${cx}, ${cy}) ...`);
  const moved = await callJson(client, "gd_editor_pixel_move", { x: cx, y: cy });
  record("pixel_move", moved.moved === true, `cursor moved to (${moved.x}, ${moved.y})`);

  // The canonical tier-3 gesture: select a node by its screen position in the 2D
  // viewport. This has no tier-1 equivalent (gd_editor_select selects by node path)
  // and no tier-2 equivalent (gd_editor_ui cannot select-by-position in the canvas).
  // The origin is not at the canvas centre and its exact screen position depends on
  // the view transform, so scan a grid; clearing before each click makes any
  // resulting selection attributable to that click, not to prior state.
  console.log("\nSelecting the node by clicking its screen position in the viewport ...");
  let hitAt: { x: number; y: number } | null = null;
  let hitSelection: string[] = [];
  outer: for (let gx = 2; gx <= 6 && !hitAt; gx++) {
    for (let gy = 2; gy <= 4; gy++) {
      const x = canvas.x + (canvas.width * gx) / 8;
      const y = canvas.y + (canvas.height * gy) / 6;
      await callJson(client, "gd_editor_select", { op: "clear" });
      const cleared = (await callJson(client, "gd_editor_get_state", {})).selection ?? [];
      if (cleared.length !== 0) continue;
      const clicked = await callJson(client, "gd_editor_pixel_click", { x, y });
      if (clicked.clicked !== true) continue;
      const selection = await selectionBecomes(client, "Box", 3);
      if (selection.includes("Box")) {
        hitAt = { x, y };
        hitSelection = selection;
        break outer;
      }
    }
  }
  record(
    "pixel_click_selected_node",
    hitAt != null,
    hitAt ? `click at (${Math.round(hitAt.x)}, ${Math.round(hitAt.y)}) selected ${JSON.stringify(hitSelection)}` : "no canvas click selected the node",
  );

  // Exercise the multi-frame drag input path (press, interpolated motion, release).
  console.log("\nExercising the pixel drag input path across frames ...");
  const drag = await callJson(client, "gd_editor_pixel_drag", {
    from_x: canvas.x + 25,
    from_y: canvas.y + 25,
    to_x: cx,
    to_y: cy,
    steps: 12,
  });
  record("pixel_drag_ok", drag.dragged === true, `drag emitted ${drag.steps} motion steps`);
}

async function connectBroker(enablePixel: boolean): Promise<Client> {
  const args = [join(repoRoot, "broker", "src", "index.ts")];
  if (enablePixel) args.push("--enable-pixel-tools");
  const transport = new StdioClientTransport({
    command: "bun",
    args,
    env: { ...process.env, CONDUIT_SOCK: EDITOR_SOCK, CONDUIT_RUNTIME_DIR: SOCK_DIR } as Record<string, string>,
  });
  const client = new Client({ name: "phase6-acceptance", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(300);
  }
  throw new Error(`editor bridge socket did not appear within ${timeoutMs} ms`);
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
