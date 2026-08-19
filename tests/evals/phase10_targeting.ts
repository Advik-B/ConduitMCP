#!/usr/bin/env bun
// Live acceptance for the three generic verbs that close the coverage-matrix
// gaps: singleton targeting, the edit-time method call, and resource read and
// call (docs/coverage-matrix.md, "Proposed roadmap").
//
// The load-bearing detail is that the broker runs with --disable-eval. That
// flag drops gd_game_eval, gd_editor_eval, and the project-tool surface, so
// every check here proves the capability is reached through a semantic tool and
// not through arbitrary GDScript wearing one as a hat. A version of this runner
// without the flag would pass even if none of the new code existed.
//
// Headless editor only: all three verbs are edit-time or bridge-agnostic, and
// gd_play from a headless editor remains unproven (docs/api-gaps.md).
//
// Run with `bun tests/evals/phase10_targeting.ts` (needs GODOT_BIN).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeClient } from "../../broker/src/ipc-client.ts";
import {
  conduitEnv,
  endpointKey,
  exampleProject,
  godotCommand,
  killTree,
  repoRoot,
  resolveGodot,
  runtimeDir,
  waitForEditor,
  waitForGameEndpoint,
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p10");
const GAME_RUNTIME_DIR = runtimeDir("p10game");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");
const MAIN_TSCN_PATH = join(exampleProject, "main.tscn");
const CURVE_PATH = "res://conduit_phase10_curve.tres";
const CURVE_FILE = join(exampleProject, "conduit_phase10_curve.tres");

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
}
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

/** Expect a tool call to fail, and return the error text for inspection. */
async function callExpectingError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded: ${text}`);
  }
  return text;
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  const originalMainTscn = readFileSync(MAIN_TSCN_PATH);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching headless editor ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--headless", "--editor", "--path", "example-project", "--log-file", EDITOR_LOG], false),
    { cwd: repoRoot, env: conduitEnv(RUNTIME_DIR), stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 60_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker(["--disable-eval"]);
    await assertEvalIsGone(client);
    await singletonChecks(client);
    await sceneNodeCallChecks(client);
    await resourceChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    rmSync(CURVE_FILE, { force: true });
    rmSync(`${CURVE_FILE}.uid`, { force: true });
    writeFileSync(MAIN_TSCN_PATH, originalMainTscn);
  }

  await gameBridgeSingletonChecks(godot);

  console.log("\n=== Phase 10 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 10 checks passed.");
}

/**
 * The premise of the whole runner. If either eval tool is registered, every
 * later check could be passing for the wrong reason.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);

  const expected = ["gd_scene_node_call", "gd_resource_get_property", "gd_resource_call"];
  const missing = expected.filter((n) => !names.includes(n));
  record("new_tools_registered", missing.length === 0, missing.length === 0 ? expected.join(", ") : `missing ${missing.join(", ")}`);
}

/** Singleton targeting: read, call, and write, none of them through a node. */
async function singletonChecks(client: Client): Promise<void> {
  console.log("\nSingleton targeting ...");

  const osName = await callJson(client, "gd_scene_node_call", { target: "singleton:OS", method: "get_name" });
  record(
    "singleton_call",
    typeof osName.result === "string" && osName.result.length > 0 && osName.target === "singleton:OS",
    `OS.get_name() -> ${JSON.stringify(osName.result)}`,
  );

  const projectName = await callJson(client, "gd_scene_node_call", {
    target: "singleton:ProjectSettings",
    method: "get_setting",
    args: ["application/config/name"],
  });
  record(
    "singleton_call_with_args",
    typeof projectName.result === "string" && projectName.result.length > 0,
    `ProjectSettings.get_setting("application/config/name") -> ${JSON.stringify(projectName.result)}`,
  );

  // A read through the property path rather than the method path, proving the
  // grammar reaches all three verbs and not just calls.
  const editorProp = await callJson(client, "gd_scene_node_get_property", {
    target: "singleton:Engine",
    property: "physics_ticks_per_second",
  });
  record(
    "singleton_get_property",
    typeof editorProp.value === "number" && editorProp.value > 0,
    `Engine.physics_ticks_per_second -> ${editorProp.value}`,
  );

  // This is the one check that mutates engine-global state, so the restore sits
  // in a finally: a failed assertion between the write and the restore would
  // otherwise leave the tick rate changed for every check after it.
  const previousTicks = editorProp.value as number;
  try {
    const written = await callJson(client, "gd_scene_node_set_property", {
      target: "singleton:Engine",
      property: "physics_ticks_per_second",
      value: previousTicks + 5,
    });
    const readBack = await callJson(client, "gd_scene_node_get_property", {
      target: "singleton:Engine",
      property: "physics_ticks_per_second",
    });
    record(
      "singleton_set_property",
      readBack.value === previousTicks + 5 && written.undoable === false,
      `wrote ${previousTicks + 5}, read back ${readBack.value}, undoable=${written.undoable}`,
    );
  } finally {
    await callJson(client, "gd_scene_node_set_property", {
      target: "singleton:Engine",
      property: "physics_ticks_per_second",
      value: previousTicks,
    });
  }

  const unknown = await callExpectingError(client, "gd_scene_node_call", {
    target: "singleton:NotARealSingleton",
    method: "get_name",
  });
  record(
    "unknown_singleton_lists_alternatives",
    unknown.includes("no singleton named") && unknown.includes("OS"),
    "the error names the available singletons rather than failing opaquely",
  );

  const conflict = await callExpectingError(client, "gd_scene_node_call", {
    target: "singleton:OS",
    node_path: ".",
    method: "get_name",
  });
  record("target_conflict_rejected", conflict.includes("not both"), "passing target and node_path together is an error");
}

/** The edit-time method call, on a real node in the edited scene. */
async function sceneNodeCallChecks(client: Client): Promise<void> {
  console.log("\nEdit-time method call ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });

  await callJson(client, "gd_node_add", {
    parent_path: ".",
    type: "TileMapLayer",
    name: "Phase10Layer",
  });

  // set_cell is the canonical case from the coverage report: a node method that
  // works at runtime through gd_node_call and, before gd_scene_node_call
  // existed, had no edit-time path except gd_editor_eval.
  await callJson(client, "gd_scene_node_call", {
    node_path: "Phase10Layer",
    method: "set_cell",
    args: [{ __type: "Vector2i", x: 3, y: 4 }, 0, { __type: "Vector2i", x: 0, y: 0 }, 0],
  });
  const source = await callJson(client, "gd_scene_node_call", {
    node_path: "Phase10Layer",
    method: "get_cell_source_id",
    args: [{ __type: "Vector2i", x: 3, y: 4 }],
  });
  // With no TileSet assigned the write is rejected by the engine and the cell
  // reads back as empty (-1); what is being proven here is that the call
  // reached the node and returned its real answer, not that a tile exists.
  record(
    "scene_node_call_roundtrip",
    typeof source.result === "number" && source.node_path === "Phase10Layer",
    `set_cell then get_cell_source_id -> ${source.result} on ${source.node_path}`,
  );

  const undoable = await callJson(client, "gd_scene_node_call", {
    node_path: "Phase10Layer",
    method: "get_class",
  });
  record(
    "scene_node_call_reports_not_undoable",
    undoable.undoable === false && undoable.result === "TileMapLayer",
    `get_class -> ${undoable.result}, undoable=${undoable.undoable}`,
  );

  const missing = await callExpectingError(client, "gd_scene_node_call", {
    node_path: "Phase10Layer",
    method: "no_such_method",
  });
  record("scene_node_call_unknown_method", missing.includes("no method"), "an unknown method is a clean error");

  // The claim the handler's doc comment makes, tested rather than asserted: a
  // method call must leave nothing on the undo stack. Set a property first --
  // that DOES create an entry -- then make a call, then undo exactly once. If
  // the call had pushed an entry of its own, this undo would consume that
  // instead and the property write would survive, which is precisely the
  // misreporting the no-wrapping decision exists to prevent.
  await callJson(client, "gd_scene_node_set_property", {
    node_path: "Phase10Layer",
    property: "y_sort_enabled",
    value: true,
  });
  await callJson(client, "gd_scene_node_call", {
    node_path: "Phase10Layer",
    method: "set_cell",
    args: [{ __type: "Vector2i", x: 7, y: 7 }, 0, { __type: "Vector2i", x: 0, y: 0 }, 0],
  });
  const undone = await callJson(client, "gd_undo", {});
  const afterUndo = await callJson(client, "gd_scene_node_get_property", {
    node_path: "Phase10Layer",
    property: "y_sort_enabled",
  });
  record(
    "scene_node_call_absent_from_undo_stack",
    undone.performed === true && afterUndo.value === false,
    `one undo reverted the property write (y_sort_enabled -> ${afterUndo.value}), so the call pushed nothing`,
  );

  await callJson(client, "gd_node_remove", { node_path: "Phase10Layer" });
}

/** Resource read and call, the half of the resource surface that was missing. */
async function resourceChecks(client: Client): Promise<void> {
  console.log("\nResource read and call ...");
  await callJson(client, "gd_resource_create", { class_name: "Curve", path: CURVE_PATH });

  // The read happens with no preceding write in this session, which is exactly
  // what gd_resource_set_property's return value could never provide.
  const listed = await callJson(client, "gd_resource_get_property", { path: CURVE_PATH, op: "list" });
  record(
    "resource_property_list",
    Array.isArray(listed.properties) && listed.properties.includes("resource_name") && listed.class_name === "Curve",
    `${listed.class_name} lists ${listed.properties.length} properties`,
  );

  const pointCountBefore = await callJson(client, "gd_resource_call", {
    path: CURVE_PATH,
    method: "get_point_count",
    save: false,
  });
  await callJson(client, "gd_resource_call", {
    path: CURVE_PATH,
    method: "add_point",
    args: [{ __type: "Vector2", x: 0.5, y: 0.5 }],
  });
  const pointCountAfter = await callJson(client, "gd_resource_call", {
    path: CURVE_PATH,
    method: "get_point_count",
    save: false,
  });
  record(
    "resource_call_mutates_and_persists",
    pointCountAfter.result === pointCountBefore.result + 1 && pointCountAfter.saved === false,
    `Curve.add_point took point count ${pointCountBefore.result} -> ${pointCountAfter.result}`,
  );

  const read = await callJson(client, "gd_resource_get_property", {
    path: CURVE_PATH,
    op: "get",
    property: "point_count",
  });
  record(
    "resource_get_property_without_writing",
    read.value === pointCountAfter.result,
    `point_count read back as ${read.value} without a preceding write`,
  );

  // Rejected by the broker's zod enum before the bridge is reached, which is
  // the better of the two layers to catch it in; the handler keeps its own
  // "unknown op" guard for callers that speak the bridge protocol directly.
  const badOp = await callExpectingError(client, "gd_resource_get_property", { path: CURVE_PATH, op: "nope" });
  record(
    "resource_get_property_rejects_bad_op",
    badOp.toLowerCase().includes("invalid") || badOp.includes("unknown op"),
    "an unknown op is rejected at the schema boundary",
  );
}

/**
 * The same resolver on the other bridge. The editor checks above prove the
 * grammar and the singleton lookup; this proves gd_node_call carries them into
 * the game process too, which is otherwise only inferred from shared code.
 *
 * Talks the bridge protocol directly, matching phase 7: the broker only adopts
 * games it launched itself, and gd_play from a headless editor is unproven
 * (docs/api-gaps.md).
 */
async function gameBridgeSingletonChecks(godot: string): Promise<void> {
  console.log("\nGame-bridge singleton targeting ...");
  rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(GAME_RUNTIME_DIR, { recursive: true });

  const game = Bun.spawn(godotCommand(godot, ["--headless", "--path", "example-project"], false), {
    cwd: repoRoot,
    env: conduitEnv(GAME_RUNTIME_DIR),
    stdout: "ignore",
    stderr: "ignore",
  });

  let bridge: BridgeClient | null = null;
  try {
    const endpoint = await waitForGameEndpoint(GAME_RUNTIME_DIR, 60_000);
    if (!endpoint) {
      record("game_singleton_call", false, "game bridge endpoint never appeared");
      return;
    }
    bridge = new BridgeClient({ endpoint, defaultTimeoutMs: 10_000 });
    await bridge.connect();
    await bridge.waitForHello(10_000);

    const os = (await bridge.request("gd_node_call", { target: "singleton:OS", method: "get_name" }, 10_000)) as any;
    record(
      "game_singleton_call",
      typeof os.result === "string" && os.result.length > 0 && os.target === "singleton:OS",
      `gd_node_call OS.get_name() -> ${JSON.stringify(os.result)} on the game bridge`,
    );

    const info = (await bridge.request("gd_node_get_info", { target: "singleton:Engine" }, 10_000)) as any;
    record(
      "game_singleton_get_info",
      info.class === "Engine" && Array.isArray(info.methods) && info.children === undefined,
      `gd_node_get_info reports ${info.class} with ${info.methods?.length} methods and no children field`,
    );

    // The pre-existing node path must still behave exactly as before.
    const node = (await bridge.request("gd_node_call", { node_path: "/root", method: "get_class" }, 10_000)) as any;
    record(
      "game_node_path_unchanged",
      node.result === "Window" && node.node_path === "/root",
      `gd_node_call with node_path still echoes node_path (${node.node_path} -> ${node.result})`,
    );
  } finally {
    bridge?.close();
    killTree(game);
    await game.exited.catch(() => {});
    rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  }
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase10-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
