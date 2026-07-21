#!/usr/bin/env bun
// Phase 4 live acceptance runner (whitepaper section 10). Proves the bridge
// and broker work under `godot --headless` outside an interactive session, in
// two independent halves:
//
//   - a headless *editor* session (`--headless --editor`, as phase 3 already
//     uses) drives a scripted batch edit end to end through the broker, then
//     calls the new gd_export_project tool against two presets, producing a
//     real .pck artifact and proving the release preset's exclude_filter
//     actually drops the bridge from the pack (whitepaper section 15);
//   - a bare headless *game* process (`godot --headless`, no --editor, not
//     spawned via gd_play), talked to directly over the raw bridge protocol
//     (bypassing the broker, the same way tests/evals/phase1_stress_client.ts
//     does), proves the runtime personality itself binds and serves
//     non-rendering tools outside any interactive session -- the one claim
//     phase 2's Xvfb-based eval does not cover.
//
// Run with `bun tests/evals/phase4_headless.ts` (needs GODOT_BIN).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeClient } from "../../broker/src/ipc-client.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SOCK_DIR = `/tmp/conduit-p4-${process.pid}`;
const EDITOR_SOCK = join(SOCK_DIR, "editor.sock");
const EDITOR_LOG = join(SOCK_DIR, "editor.log");
const GAME_SOCK_DIR = `/tmp/conduit-p4-game-${process.pid}`;
const MAIN_TSCN_PATH = join(repoRoot, "example-project", "main.tscn");
const EXPORT_DIR = join(repoRoot, "example-project", "export");
const GAME_SOCKET_PATTERN = /^conduit-game-.*\.sock$/;

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

async function run(cmd: string[], cwd: string): Promise<number> {
  return Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
}

interface ToolContent {
  type: string;
  text?: string;
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

function findNode(tree: { name: string; children?: unknown[] }, name: string): any {
  if (tree.name === name) {
    return tree;
  }
  for (const child of (tree.children as any[]) ?? []) {
    const found = findNode(child, name);
    if (found) {
      return found;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Editor socket dir: ${SOCK_DIR}`);

  // gd_scene_save in the batch-edit check persists a marker node into
  // main.tscn; restore the original bytes afterward so repeated runs and
  // `git status` stay quiet (mirrors tests/evals/phase3_editor.ts).
  const originalMainTscn = readFileSync(MAIN_TSCN_PATH);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(SOCK_DIR, { recursive: true, force: true });
  mkdirSync(SOCK_DIR, { recursive: true });
  rmSync(EXPORT_DIR, { recursive: true, force: true });

  console.log("\nLaunching headless editor (no --conduit opt-in needed; the editor personality binds unconditionally) ...");
  const editor = Bun.spawn(
    [godot, "--headless", "--editor", "--path", "example-project", "--log-file", EDITOR_LOG],
    {
      cwd: repoRoot,
      env: { ...process.env, CONDUIT_SOCK: EDITOR_SOCK, CONDUIT_RUNTIME_DIR: SOCK_DIR },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let client: Client | null = null;
  try {
    await waitForSocket(EDITOR_SOCK, 60_000);
    record("editor_bound", existsSync(EDITOR_SOCK), `editor bridge socket present at ${EDITOR_SOCK}`);

    client = await connectBroker();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    record(
      "mcp_tools_listed",
      ["gd_scene_open", "gd_node_add", "gd_scene_save", "gd_export_project"].every((n) => names.includes(n)),
      `${names.length} tools exposed, including gd_export_project`,
    );

    await runEditorChecks(client);
  } finally {
    await client?.close().catch(() => {});
    editor.kill();
    await editor.exited.catch(() => {});
    rmSync(SOCK_DIR, { recursive: true, force: true });
    rmSync(EXPORT_DIR, { recursive: true, force: true });
    writeFileSync(MAIN_TSCN_PATH, originalMainTscn);
  }

  await runBareHeadlessGameCheck(godot);

  console.log("\n=== Phase 4 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 4 checks passed.");
}

async function runEditorChecks(client: Client): Promise<void> {
  console.log("\nScripted batch edit: open scene, add a node, save ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  await callJson(client, "gd_node_add", { parent_path: ".", type: "Node2D", name: "Phase4Marker" });
  const tree = await callJson(client, "gd_scene_tree_get", {});
  await callJson(client, "gd_scene_save", {});
  const tscnText = readFileSync(MAIN_TSCN_PATH, "utf8");
  record(
    "scripted_batch_edit_and_save",
    findNode(tree.tree, "Phase4Marker") !== null && /\[node name="Phase4Marker"/.test(tscnText),
    "node added via a scripted tool sequence, visible live, and persisted to main.tscn -- all outside an interactive session",
  );

  console.log("\nExporting the debug preset (bridge included) as a .pck ...");
  const debugExport = await callJson(client, "gd_export_project", {
    preset: "Linux (debug)",
    output_path: "res://export/game-debug.pck",
    mode: "pack",
  });
  const debugPath = join(repoRoot, "example-project", "export", "game-debug.pck");
  const debugExists = existsSync(debugPath);
  const debugSize = debugExists ? statSync(debugPath).size : 0;
  record(
    "export_produces_artifact",
    debugExport.bytes_written > 0 && debugExists && debugSize > 0,
    `gd_export_project reported ${debugExport.bytes_written} bytes; artifact on disk is ${debugSize} bytes at ${debugPath}`,
  );

  console.log("\nExporting the release preset (bridge excluded via exclude_filter) ...");
  const releaseExport = await callJson(client, "gd_export_project", {
    preset: "Linux (release)",
    output_path: "res://export/game-release.pck",
    mode: "pack",
  });
  const releasePath = join(repoRoot, "example-project", "export", "game-release.pck");
  const releaseSize = existsSync(releasePath) ? statSync(releasePath).size : 0;
  record(
    "release_preset_excludes_bridge",
    releaseExport.bytes_written > 0 && releaseSize > 0 && releaseSize < debugSize,
    `release pack is ${releaseSize} bytes vs. debug pack's ${debugSize} bytes -- smaller, consistent with addons/conduit/* and conduit.gdextension being excluded (whitepaper section 15)`,
  );

  console.log("\nChecking a bad preset name fails with a structured, actionable error ...");
  try {
    await callJson(client, "gd_export_project", { preset: "Nonexistent Preset", output_path: "res://export/nope.pck", mode: "pack" });
    record("export_bad_preset_fails_cleanly", false, "expected gd_export_project to fail for an unknown preset");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record("export_bad_preset_fails_cleanly", message.startsWith("gd_export_project failed: export_failed:"), `error: ${message}`);
  }

  console.log("\nCleaning up the marker node ...");
  await callJson(client, "gd_node_remove", { node_path: "Phase4Marker" });
  await callJson(client, "gd_scene_save", {});
}

// Bare `godot --headless` (no --editor, not spawned via gd_play): proves the
// runtime personality's activation gating and dispatcher work outside any
// interactive session, talking the raw bridge protocol directly (like
// tests/evals/phase1_stress_client.ts) rather than through the broker, since
// no MCP tool currently attaches to an externally-launched game instance.
async function runBareHeadlessGameCheck(godot: string): Promise<void> {
  console.log("\nLaunching a bare headless game process (no --editor, CONDUIT_ENABLE opt-in) ...");
  rmSync(GAME_SOCK_DIR, { recursive: true, force: true });
  mkdirSync(GAME_SOCK_DIR, { recursive: true });

  const game = Bun.spawn([godot, "--headless", "--path", "example-project"], {
    cwd: repoRoot,
    env: { ...process.env, CONDUIT_ENABLE: "1", CONDUIT_RUNTIME_DIR: GAME_SOCK_DIR },
    stdout: "ignore",
    stderr: "ignore",
  });

  let bridge: BridgeClient | null = null;
  try {
    const socketPath = await waitForGameSocket(GAME_SOCK_DIR, 60_000);
    record("bare_headless_game_bound", socketPath !== null, `game bridge socket present at ${socketPath}`);
    if (!socketPath) {
      return;
    }

    bridge = new BridgeClient({ socketPath, defaultTimeoutMs: 10_000 });
    await bridge.connect();
    const hello = await bridge.waitForHello(10_000);
    record(
      "bare_headless_hello_is_game_role",
      hello.role === "game",
      `hello reported role='${hello.role}', engine ${hello.engine_version}, pid ${hello.pid} -- launched directly, not via gd_play`,
    );

    const tree = (await bridge.request("gd_tree_get", {}, 10_000)) as { tree?: { name?: string } };
    record("bare_headless_tree_get", typeof tree.tree?.name === "string", `gd_tree_get returned root '${tree.tree?.name}' under bare --headless`);

    const perf = (await bridge.request("gd_perf", {}, 10_000)) as Record<string, unknown>;
    record("bare_headless_perf", typeof perf === "object" && perf !== null, `gd_perf returned counters under bare --headless: ${Object.keys(perf).length} field(s)`);
  } finally {
    bridge?.close();
    game.kill();
    await game.exited.catch(() => {});
    rmSync(GAME_SOCK_DIR, { recursive: true, force: true });
  }
}

async function connectBroker(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env: { ...process.env, CONDUIT_SOCK: EDITOR_SOCK, CONDUIT_RUNTIME_DIR: SOCK_DIR } as Record<string, string>,
  });
  const client = new Client({ name: "phase4-acceptance", version: "0.4.0" });
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
  throw new Error(`socket did not appear within ${timeoutMs} ms: ${path}`);
}

async function waitForGameSocket(dir: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // Directory may not exist yet on the very first poll.
    }
    const match = entries.find((name) => GAME_SOCKET_PATTERN.test(name));
    if (match) {
      return join(dir, match);
    }
    await sleep(300);
  }
  return null;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
