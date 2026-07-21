#!/usr/bin/env bun
// Phase 6 live acceptance runner (whitepaper section 10). It drives the phase 6
// acceptance criterion end to end through the broker against a real editor under
// a virtual display (Xvfb):
//
//   - with no opt-in flag, the four tier-3 pixel tools are absent from the surface;
//   - with --enable-pixel-tools, they appear;
//   - gd_editor_window_info reports the editor window geometry and scale;
//   - a pixel click on a control's computed rect drives the editor with a
//     deterministic, semantically-readable outcome (the main screen switches),
//     proving Viewport::push_input reaches the editor;
//   - pixel move and drag execute across the input path without error.
//
// The pixel tools exist for gestures with no semantic or tier-2 equivalent; the
// main-screen button is used here only because its outcome is deterministically
// readable, which a raw viewport gesture is not.
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
    ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", godot, "--editor", "--rendering-driver", "opengl3", "--path", "example-project"],
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

async function runGestureChecks(client: Client): Promise<void> {
  console.log("\nReading editor window geometry ...");
  const info = await callJson(client, "gd_editor_window_info", {});
  record(
    "window_info",
    info.headless === false && info.size?.width > 0 && info.size?.height > 0 && typeof info.editor_scale === "number",
    `size ${info.size?.width}x${info.size?.height}, editor_scale ${info.editor_scale}`,
  );

  console.log("\nPreparing a deterministic target (main screen = 2D) ...");
  await callJson(client, "gd_editor_set_main_screen", { name: "2D" });
  const before = await callJson(client, "gd_editor_get_state", {});
  record("main_screen_2d", before.main_screen === "2D", `main screen is ${before.main_screen}`);

  // Locate the "3D" main-screen button and its screen rect through tier-2, so the
  // pixel coordinate is computed, not guessed.
  const found = await callJson(client, "gd_editor_ui", { op: "find", class: "Button", limit: 200 });
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  for (const c of found.controls ?? []) {
    if (c.text !== "3D") continue;
    const described = await callJson(client, "gd_editor_ui", { op: "describe", path: c.path });
    if (described.visible && described.rect) {
      rect = described.rect;
      break;
    }
  }
  record("located_3d_button", rect != null, rect ? `3D button rect ${JSON.stringify(rect)}` : "no visible 3D button rect found");
  if (!rect) return;

  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  console.log(`\nMoving the synthetic cursor to (${cx}, ${cy}) ...`);
  const moved = await callJson(client, "gd_editor_pixel_move", { x: cx, y: cy });
  record("pixel_move", moved.moved === true, `cursor moved to (${moved.x}, ${moved.y})`);

  console.log("\nClicking the 3D button through pixel input ...");
  const clicked = await callJson(client, "gd_editor_pixel_click", { x: cx, y: cy });
  record("pixel_click_ok", clicked.clicked === true, `clicked at (${clicked.x}, ${clicked.y})`);

  let switched = false;
  let after = before;
  for (let i = 0; i < 25 && !switched; i++) {
    after = await callJson(client, "gd_editor_get_state", {});
    switched = after.main_screen === "3D";
    if (!switched) await sleep(200);
  }
  record("pixel_click_switched_main_screen", switched, `main screen after the pixel click is ${after.main_screen}`);

  console.log("\nExercising a pixel drag across the input path ...");
  const drag = await callJson(client, "gd_editor_pixel_drag", { from_x: cx, from_y: cy + 200, to_x: cx + 80, to_y: cy + 200, steps: 6 });
  record("pixel_drag_ok", drag.dragged === true, `drag emitted ${drag.steps} motion steps`);

  // Leave the editor as we found it.
  await callJson(client, "gd_editor_set_main_screen", { name: "2D" });
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
