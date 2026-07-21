#!/usr/bin/env bun
// Phase 5 live acceptance runner (whitepaper section 10). It drives the phase 5
// acceptance criterion end to end through the broker against a real editor under
// a virtual display (Xvfb):
//
//   - set a breakpoint in a script and confirm it is listed;
//   - run the game and trigger the breakpoint through simulated input;
//   - see the break surfaced as a distinct game_breaked state, not a timeout;
//   - read the stack and a local variable's value at the break;
//   - step one line and see the stack advance;
//   - continue and see game-bridge tools work again;
//   - dirty a scene, trigger a confirmation dialog through the tier-2 UI, and
//     dismiss it through the dialog tools, all without pixel input.
//
// Run with `bun tests/evals/phase5_debugger.ts` (needs GODOT_BIN and a display:
// native on Windows/macOS, Xvfb on Linux -- the harness wraps it automatically).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  endpointKey,
  exampleProject,
  godotCommand,
  killTree,
  repoRoot,
  requireDisplay,
  resolveGodot,
  runtimeDir,
  waitForEditor,
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p5");
const MAIN_SCENE = join(exampleProject, "main.tscn");
const BREAK_LINE = 24; // player.gd: position.x += SPEED * delta (input-gated)
const AWAIT = 60_000;

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
  requireDisplay();
  console.log(`Godot: ${godot}\nRuntime dir: ${RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await Bun.spawn(["cargo", "build", "-p", "conduit"], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" }).exited) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const originalScene = readFileSync(MAIN_SCENE);

  console.log("\nLaunching editor with a display ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--editor", "--rendering-driver", "opengl3", "--path", "example-project"], true),
    {
      cwd: repoRoot,
      env: conduitEnv(RUNTIME_DIR),
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 120_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker();
    const names = (await client.listTools()).tools.map((t) => t.name);
    record(
      "phase5_tools_listed",
      ["gd_debug", "gd_editor_list_dialogs", "gd_editor_dialog_choose", "gd_editor_ui"].every((n) => names.includes(n)),
      `${names.length} tools exposed`,
    );

    await runDebuggerChecks(client);
    await runDialogChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    writeFileSync(MAIN_SCENE, originalScene);
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 5 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 5 checks passed.");
}

async function runDebuggerChecks(client: Client): Promise<void> {
  console.log("\nSetting a breakpoint ...");
  await callJson(client, "gd_debug", { op: "set_breakpoint", path: "res://player.gd", line: BREAK_LINE });
  const list = await callJson(client, "gd_debug", { op: "list_breakpoints" });
  record(
    "set_breakpoint",
    (list.breakpoints ?? []).some((b: any) => b.path === "res://player.gd" && b.line === BREAK_LINE),
    `breakpoint at player.gd:${BREAK_LINE} is listed`,
  );

  console.log("\nRunning the game ...");
  const play = await callJson(client, "gd_play", {});
  record("play_and_connect", play.game_bridge_connected === true, `game launched (pid ${play.instance?.pid})`);

  // Wait for the debugger session to attach (isolates "session never started"
  // from "breakpoint never hit").
  let sessionActive = false;
  for (let i = 0; i < 50 && !sessionActive; i++) {
    const state = await callJson(client, "gd_editor_get_state", {});
    sessionActive = (state.debug?.sessions ?? []).some((s: any) => s.active);
    if (!sessionActive) await sleep(200);
  }
  record("debug_session_attached", sessionActive, "a debug session is active for the launched game");

  console.log("\nTriggering the breakpoint through simulated input ...");
  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: true });

  let breaked = false;
  for (let i = 0; i < 75 && !breaked; i++) {
    const status = await callJson(client, "gd_status", {});
    breaked = status.debug?.breaked === true;
    if (!breaked) await sleep(200);
  }
  record("breaked", breaked, "the game halted at the breakpoint");

  const events = await callJson(client, "gd_get_events", {});
  record(
    "debug_breaked_event",
    (events.events ?? []).some((e: any) => e.type === "debug_breaked"),
    "the broker surfaced a debug_breaked event",
  );

  const perf = await callRaw(client, "gd_perf", {});
  record(
    "game_breaked_distinct",
    perf.isError && perf.text.startsWith("game_breaked"),
    `a game tool reports game_breaked, not a timeout`,
  );

  console.log("\nReading the stack and a local variable ...");
  const stack = await callJson(client, "gd_debug", { op: "stack" });
  const frame0 = stack.frames?.[0];
  record(
    "stack",
    frame0?.file === "res://player.gd" && frame0?.line === BREAK_LINE && String(frame0?.function).includes("_process"),
    `frame 0 = ${frame0?.file}:${frame0?.line} in ${frame0?.function}`,
  );

  const vars = await callJson(client, "gd_debug", { op: "vars", frame: 0 });
  const delta = vars.locals?.delta;
  record("vars", typeof delta === "number" && delta > 0, `local delta = ${delta}`);

  console.log("\nStepping one line ...");
  await callJson(client, "gd_debug", { op: "step_over" });
  // A step briefly resumes the game before it re-halts at the next line; poll
  // for the stack to settle rather than reading it mid-step. A single read
  // happened to catch a settled stack on Linux but hit the resumed window on
  // Windows (empty frames -> line null).
  let line2: unknown = null;
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const settled = await callJson(client, "gd_debug", { op: "stack" });
    const l = settled.frames?.[0]?.line;
    if (typeof l === "number") {
      line2 = l;
      if (l !== BREAK_LINE) break;
    }
  }
  record("step_over", typeof line2 === "number" && line2 !== BREAK_LINE, `stack advanced to line ${line2}`);

  console.log("\nContinuing ...");
  // Clear first: the held action would re-break at the same line next frame.
  await callJson(client, "gd_debug", { op: "clear_breakpoint", all: true });
  await callJson(client, "gd_debug", { op: "continue" });
  let resumed = false;
  for (let i = 0; i < 25 && !resumed; i++) {
    const status = await callJson(client, "gd_status", {});
    resumed = status.debug?.breaked === false;
    if (!resumed) await sleep(200);
  }
  const perfAfter = await callRaw(client, "gd_perf", {});
  record("continue", resumed && !perfAfter.isError, "the game resumed and game-bridge tools work again");

  await callJson(client, "gd_input", { device: "action", action: "move_right", pressed: false });
  await callJson(client, "gd_stop", {});
}

async function runDialogChecks(client: Client): Promise<void> {
  console.log("\nDirtying a scene and triggering a confirmation dialog ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  await callJson(client, "gd_node_add", { parent_path: ".", type: "Node2D", name: "Dirtier" });

  // Find the Scene menu's Close Scene entry through the tier-2 UI.
  const found = await callJson(client, "gd_editor_ui", { op: "find", class: "PopupMenu", limit: 80 });
  let menu: { path: string; id: number } | null = null;
  for (const p of found.controls ?? []) {
    const described = await callJson(client, "gd_editor_ui", { op: "describe", path: p.path });
    const item = (described.items ?? []).find((it: any) => /close scene/i.test(it.text ?? ""));
    if (item) {
      menu = { path: p.path, id: item.id };
      break;
    }
  }
  record("found_close_scene_menu", menu != null, menu ? `Close Scene id=${menu.id}` : "no Close Scene menu item found");
  if (!menu) return;

  await callJson(client, "gd_editor_ui", { op: "select_item", path: menu.path, id: menu.id });

  let dialogs: any[] = [];
  for (let i = 0; i < 15 && dialogs.length === 0; i++) {
    dialogs = (await callJson(client, "gd_editor_list_dialogs", {})).dialogs ?? [];
    if (dialogs.length === 0) await sleep(300);
  }
  const confirm = dialogs.find((d: any) => /confirm/i.test(d.class) || /save/i.test(d.text));
  record(
    "confirmation_dialog_shown",
    confirm != null && (confirm.buttons ?? []).some((b: string) => /cancel/i.test(b)),
    confirm ? `dialog "${confirm.title}" with buttons ${JSON.stringify(confirm.buttons)}` : "no confirmation dialog appeared",
  );
  if (!confirm) return;

  console.log("\nDismissing the dialog through the dialog tools ...");
  await callJson(client, "gd_editor_dialog_choose", { button: "Cancel" });
  const after = (await callJson(client, "gd_editor_list_dialogs", {})).dialogs ?? [];
  record("dialog_dismissed", after.length === 0, "the confirmation dialog was dismissed without pixel input");
}

async function connectBroker(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase5-acceptance", version: "0.2.0" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
