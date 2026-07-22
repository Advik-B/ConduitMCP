#!/usr/bin/env bun
// Phase 7 live acceptance runner (whitepaper section 10). Edit-time parity
// core: ClassDB introspection with pagination, undo-wrapped node property
// set, initial properties on node add, scene instancing, persisted signal
// connections, persistent groups, node search on both bridges, autoload and
// input-map management, and the gd_editor_eval opt-in gate.
//
// Fully headless, split acceptance like phase 4: part A drives a headless
// --editor session through the broker; part B talks the raw bridge protocol
// to a bare headless game (gd_play from a headless editor is unproven, and
// the broker only adopts games it launches itself).
//
// Run with `bun tests/evals/phase7_parity.ts` (needs GODOT_BIN).

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

const RUNTIME_DIR = runtimeDir("p7");
const GAME_RUNTIME_DIR = runtimeDir("p7game");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");
const MAIN_TSCN_PATH = join(exampleProject, "main.tscn");
const PROJECT_GODOT_PATH = join(exampleProject, "project.godot");

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

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  // The checks mutate main.tscn (saved instance, connection, groups) and
  // project.godot (autoload, input map); restore both byte-for-byte so
  // repeated runs and `git status` stay quiet.
  const originalMainTscn = readFileSync(MAIN_TSCN_PATH);
  const originalProjectGodot = readFileSync(PROJECT_GODOT_PATH);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching headless editor ...");
  const editor = Bun.spawn(
    godotCommand(godot, ["--headless", "--editor", "--path", "example-project", "--log-file", EDITOR_LOG], false),
    {
      cwd: repoRoot,
      env: conduitEnv(RUNTIME_DIR),
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  let client: Client | null = null;
  let evalClient: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 60_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker([]);
    await runEditorChecks(client);

    // The Windows named-pipe listener serves one client at a time
    // (docs/api-gaps.md), so release the default broker before connecting
    // the eval-enabled one.
    await client.close();
    client = null;

    console.log("\nConnecting a second broker with --enable-editor-eval ...");
    evalClient = await connectBroker(["--enable-editor-eval"]);
    await runEditorEvalChecks(evalClient);
  } finally {
    await client?.close().catch(() => {});
    await evalClient?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    writeFileSync(MAIN_TSCN_PATH, originalMainTscn);
    writeFileSync(PROJECT_GODOT_PATH, originalProjectGodot);
  }

  await runBareHeadlessGameChecks(godot);

  console.log("\n=== Phase 7 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 7 checks passed.");
}

async function runEditorChecks(client: Client): Promise<void> {
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  const expectedNew = [
    "gd_classdb",
    "gd_scene_node_get_property",
    "gd_scene_node_set_property",
    "gd_scene_instantiate",
    "gd_scene_signal",
    "gd_node_group",
    "gd_scene_find_nodes",
    "gd_find_nodes",
    "gd_autoload",
    "gd_input_map",
  ];
  record(
    "phase7_tools_listed",
    expectedNew.every((n) => names.includes(n)),
    `${names.length} tools exposed, all phase 7 tools present`,
  );
  record(
    "editor_eval_absent_by_default",
    !names.includes("gd_editor_eval"),
    "gd_editor_eval is not in the default tool surface",
  );

  console.log("\nPaging through ClassDB ...");
  const page = await callJson(client, "gd_classdb", { op: "list_classes", limit: 5 });
  record(
    "classdb_pagination",
    page.items?.length === 5 && page.has_more === true && page.next_offset === 5 && page.total_count > 500,
    `5 of ${page.total_count} classes, has_more=${page.has_more}, next_offset=${page.next_offset}`,
  );
  const nextPage = await callJson(client, "gd_classdb", { op: "list_classes", limit: 5, offset: page.next_offset });
  record(
    "classdb_pagination_offset",
    nextPage.items?.length === 5 && nextPage.items[0] !== page.items[0],
    `next page starts at '${nextPage.items?.[0]}' vs '${page.items?.[0]}'`,
  );

  const info = await callJson(client, "gd_classdb", { op: "class_info", class: "Sprite2D" });
  record(
    "classdb_class_info",
    info.parent === "Node2D" && info.instantiable === true && info.counts?.properties > 0,
    `Sprite2D: parent=${info.parent}, instantiable=${info.instantiable}, ${info.counts?.properties} properties`,
  );

  const props = await callJson(client, "gd_classdb", { op: "properties", class: "Sprite2D", no_inheritance: true });
  const hasTexture = (props.items ?? []).some((p: { name: string }) => p.name === "texture");
  record("classdb_properties", hasTexture, `Sprite2D own properties include texture=${hasTexture}`);

  const exists = await callJson(client, "gd_classdb", {
    op: "exists",
    class: "Sprite2D",
    method: "set_texture",
    signal: "frame_changed",
    property: "texture",
  });
  record(
    "classdb_exists",
    exists.class_exists === true && exists.method_exists === true && exists.signal_exists === true && exists.property_exists === true,
    `class/method/signal/property existence all confirmed`,
  );

  const parents = await callJson(client, "gd_classdb", { op: "parents", class: "Sprite2D" });
  record(
    "classdb_parents",
    JSON.stringify(parents.parents) === JSON.stringify(["Node2D", "CanvasItem", "Node", "Object"]),
    `inheritance chain: ${JSON.stringify(parents.parents)}`,
  );

  const methods = await callJson(client, "gd_classdb", { op: "methods", class: "Object", limit: 200 });
  const connectMethod = (methods.items ?? []).find((m: { name: string }) => m.name === "connect");
  record(
    "classdb_method_args",
    Array.isArray(connectMethod?.args) && connectMethod.args.length >= 2 && connectMethod.args[0].name === "signal",
    `Object.connect args = ${JSON.stringify(connectMethod?.args)}`,
  );

  console.log("\nOpening main.tscn ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });

  console.log("\nAdding a node with initial properties ...");
  await callJson(client, "gd_node_add", {
    parent_path: ".",
    type: "Node2D",
    name: "P7Init",
    properties: { position: { __type: "Vector2", x: 10, y: 20 } },
  });
  const initial = await callJson(client, "gd_scene_node_get_property", { node_path: "P7Init", property: "position" });
  record(
    "node_add_initial_properties",
    initial.value?.__type === "Vector2" && initial.value.x === 10 && initial.value.y === 20,
    `P7Init.position = ${JSON.stringify(initial.value)}`,
  );

  console.log("\nSetting a property undo-wrapped ...");
  const set = await callJson(client, "gd_scene_node_set_property", {
    node_path: "P7Init",
    property: "position",
    value: { x: 42, y: 7 },
  });
  record("scene_node_set_property_previous", set.previous?.x === 10, `previous = ${JSON.stringify(set.previous)}`);

  await callJson(client, "gd_undo", {});
  const afterUndo = await callJson(client, "gd_scene_node_get_property", { node_path: "P7Init", property: "position" });
  record("set_property_single_undo", afterUndo.value?.x === 10, `after undo position.x=${afterUndo.value?.x}`);
  await callJson(client, "gd_redo", {});
  const afterRedo = await callJson(client, "gd_scene_node_get_property", { node_path: "P7Init", property: "position" });
  record("set_property_redo", afterRedo.value?.x === 42, `after redo position.x=${afterRedo.value?.x}`);

  console.log("\nRound-tripping a Resource-valued property ...");
  const texClass = await callJson(client, "gd_classdb", { op: "class_info", class: "PlaceholderTexture2D" });
  record("classdb_placeholder_texture_instantiable", texClass.instantiable === true, `PlaceholderTexture2D instantiable=${texClass.instantiable}`);
  await callJson(client, "gd_resource_create", { class_name: "PlaceholderTexture2D", path: "res://phase7_tex.tres" });
  await callJson(client, "gd_node_add", { parent_path: ".", type: "Sprite2D", name: "P7Sprite" });
  const texSet = await callJson(client, "gd_scene_node_set_property", {
    node_path: "P7Sprite",
    property: "texture",
    value: { __type: "Resource", path: "res://phase7_tex.tres" },
  });
  const texGet = await callJson(client, "gd_scene_node_get_property", { node_path: "P7Sprite", property: "texture" });
  record(
    "resource_property_round_trip",
    texSet.previous === null && texGet.value?.__type === "Resource" && texGet.value.path === "res://phase7_tex.tres",
    `texture reads back as ${JSON.stringify(texGet.value)}`,
  );

  console.log("\nInstantiating a second scene as a child ...");
  await callJson(client, "gd_scene_create", { root_type: "Node2D", path: "res://phase7_child.tscn", open: false });
  const instance = await callJson(client, "gd_scene_instantiate", {
    scene_path: "res://phase7_child.tscn",
    parent_path: ".",
    name: "ChildInstance",
  });
  record("scene_instantiate", instance.node_path === "ChildInstance", `instance at '${instance.node_path}'`);

  console.log("\nConnecting a persisted signal ...");
  await callJson(client, "gd_node_add", { parent_path: ".", type: "Timer", name: "P7Timer" });
  const connect = await callJson(client, "gd_scene_signal", {
    op: "connect",
    node_path: "P7Timer",
    signal: "timeout",
    target_path: "Player",
    method: "_on_p7_timeout",
  });
  record(
    "signal_connect_wire_then_write",
    connect.connected === true && typeof connect.note === "string",
    `connected with note for the not-yet-written method`,
  );
  const connections = await callJson(client, "gd_scene_signal", { op: "list", node_path: "P7Timer" });
  const conn = (connections.connections ?? []).find((c: { signal: string }) => c.signal === "timeout");
  record(
    "signal_list",
    conn?.target_path === "Player" && conn?.method === "_on_p7_timeout",
    `list reports ${JSON.stringify(conn)}`,
  );

  console.log("\nAdding a persistent group ...");
  await callJson(client, "gd_node_group", { op: "add", node_path: "Player", group: "phase7_group" });
  const found = await callJson(client, "gd_scene_find_nodes", { group: "phase7_group" });
  record(
    "group_add_and_find",
    found.items?.length === 1 && found.items[0].path === "Player",
    `gd_scene_find_nodes found ${JSON.stringify(found.items)}`,
  );

  console.log("\nSearching the edited scene ...");
  const byClass = await callJson(client, "gd_scene_find_nodes", { class: "Node2D" });
  const byName = await callJson(client, "gd_scene_find_nodes", { name_pattern: "Play*" });
  record(
    "scene_find_nodes_filters",
    byClass.total_count >= 3 && byName.items?.length === 1 && byName.items[0].name === "Player",
    `class:Node2D total=${byClass.total_count}, name:Play* found '${byName.items?.[0]?.name}'`,
  );

  console.log("\nSaving and checking the persisted scene text ...");
  await callJson(client, "gd_scene_save", {});
  const tscnText = readFileSync(MAIN_TSCN_PATH, "utf8");
  const instancePersisted = /\[node name="ChildInstance".*instance=ExtResource/.test(tscnText);
  const connectionPersisted = /\[connection signal="timeout" from="P7Timer" to="Player" method="_on_p7_timeout"/.test(tscnText);
  const groupPersisted = /groups=\[\s*"phase7_group"\s*\]/.test(tscnText) || tscnText.includes('groups=["phase7_group"]');
  record("save_persists_instance", instancePersisted, `instance reference in saved main.tscn=${instancePersisted}`);
  record("save_persists_connection", connectionPersisted, `[connection] block in saved main.tscn=${connectionPersisted}`);
  record("save_persists_group", groupPersisted, `groups= entry in saved main.tscn=${groupPersisted}`);

  console.log("\nUndoing the group add and disconnecting the signal ...");
  await callJson(client, "gd_node_group", { op: "remove", node_path: "Player", group: "phase7_group" });
  const groupsAfter = await callJson(client, "gd_node_group", { op: "list", node_path: "Player" });
  await callJson(client, "gd_scene_signal", {
    op: "disconnect",
    node_path: "P7Timer",
    signal: "timeout",
    target_path: "Player",
    method: "_on_p7_timeout",
  });
  const connectionsAfter = await callJson(client, "gd_scene_signal", { op: "list", node_path: "P7Timer" });
  record(
    "group_remove_and_signal_disconnect",
    (groupsAfter.groups ?? []).length === 0 && (connectionsAfter.connections ?? []).length === 0,
    `groups=${JSON.stringify(groupsAfter.groups)}, connections=${JSON.stringify(connectionsAfter.connections)}`,
  );

  console.log("\nManaging autoloads ...");
  await callJson(client, "gd_autoload", { op: "add", name: "Phase7Auto", path: "res://player.gd" });
  const autoloads = await callJson(client, "gd_autoload", { op: "list" });
  const autoEntry = (autoloads.autoloads ?? []).find((a: { name: string }) => a.name === "Phase7Auto");
  const projectText = readFileSync(PROJECT_GODOT_PATH, "utf8");
  record(
    "autoload_add_observed_in_project_godot",
    autoEntry?.enabled === true && autoEntry?.path === "res://player.gd" && projectText.includes('Phase7Auto="*res://player.gd"'),
    `list=${JSON.stringify(autoEntry)}, project.godot entry present`,
  );
  await callJson(client, "gd_autoload", { op: "remove", name: "Phase7Auto" });
  const autoloadsAfter = await callJson(client, "gd_autoload", { op: "list" });
  const autoGone = !(autoloadsAfter.autoloads ?? []).some((a: { name: string }) => a.name === "Phase7Auto");
  record(
    "autoload_remove",
    autoGone && !readFileSync(PROJECT_GODOT_PATH, "utf8").includes("Phase7Auto"),
    "autoload removed from list and project.godot",
  );

  console.log("\nManaging the input map ...");
  await callJson(client, "gd_input_map", { op: "add_action", action: "phase7_jump" });
  const added = await callJson(client, "gd_input_map", { op: "add_event", action: "phase7_jump", event: { type: "key", key: "space" } });
  const actions = await callJson(client, "gd_input_map", { op: "list" });
  const jump = (actions.actions ?? []).find((a: { action: string }) => a.action === "phase7_jump");
  const inputProjectText = readFileSync(PROJECT_GODOT_PATH, "utf8");
  record(
    "input_map_add_observed_in_project_godot",
    added.event?.keycode === 32 && jump?.events?.length === 1 && jump.events[0].keycode === 32 && inputProjectText.includes("phase7_jump"),
    `event=${JSON.stringify(jump?.events?.[0])}, project.godot entry present`,
  );
  await callJson(client, "gd_input_map", { op: "remove_event", action: "phase7_jump", event_index: 0 });
  await callJson(client, "gd_input_map", { op: "remove_action", action: "phase7_jump" });
  record(
    "input_map_remove",
    !readFileSync(PROJECT_GODOT_PATH, "utf8").includes("phase7_jump"),
    "action removed from project.godot",
  );

  console.log("\nCleaning up fixture artifacts ...");
  for (const path of ["res://phase7_child.tscn", "res://phase7_tex.tres"]) {
    try {
      await callJson(client, "gd_file_delete", { path });
    } catch (error) {
      console.log(`  (cleanup step failed, continuing: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

async function runEditorEvalChecks(evalClient: Client): Promise<void> {
  const tools = await evalClient.listTools();
  const names = tools.tools.map((t) => t.name);
  record("editor_eval_present_with_flag", names.includes("gd_editor_eval"), "gd_editor_eval exposed under --enable-editor-eval");

  const result = await callJson(evalClient, "gd_editor_eval", {
    source: "await Engine.get_main_loop().process_frame\nreturn 7",
  });
  record(
    "editor_eval_awaits_in_editor_process",
    result.value === 7,
    `awaiting snippet returned ${JSON.stringify(result.value)} (type ${result.type})`,
  );
}

// Bare headless game over the raw bridge protocol (the phase 4 pattern):
// proves gd_find_nodes and gd_classdb on the game personality.
async function runBareHeadlessGameChecks(godot: string): Promise<void> {
  console.log("\nLaunching a bare headless game process (CONDUIT_ENABLE opt-in) ...");
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
      record("game_find_nodes", false, "game bridge endpoint never appeared");
      return;
    }
    bridge = new BridgeClient({ endpoint, defaultTimeoutMs: 10_000 });
    await bridge.connect();
    await bridge.waitForHello(10_000);

    const byClass = (await bridge.request("gd_find_nodes", { class: "Node2D" }, 10_000)) as any;
    const paths = (byClass.items ?? []).map((i: { path: string }) => i.path);
    record(
      "game_find_nodes",
      byClass.total_count >= 2 && paths.every((p: string) => p.startsWith("/root")),
      `found ${byClass.total_count} Node2D nodes at ${JSON.stringify(paths)}`,
    );

    const byName = (await bridge.request("gd_find_nodes", { name_pattern: "Play*" }, 10_000)) as any;
    record(
      "game_find_nodes_glob",
      byName.items?.length === 1 && byName.items[0].name === "Player",
      `name glob found '${byName.items?.[0]?.name}'`,
    );

    const classInfo = (await bridge.request("gd_classdb", { op: "exists", class: "Node2D" }, 10_000)) as any;
    record("game_classdb", classInfo.class_exists === true, "gd_classdb answers on the game bridge");
  } finally {
    if (bridge) {
      bridge.close();
    }
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
  const client = new Client({ name: "phase7-acceptance", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
