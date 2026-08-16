#!/usr/bin/env bun
// Phase 3 live acceptance runner (whitepaper section 10). Pure edit-time, so
// unlike phase 2 this needs no Xvfb and no rendering: EditorUndoRedoManager,
// EditorFileSystem, ResourceLoader, ResourceSaver, and ClassDb are all
// non-rendering editor systems, and phase 1's own eval already proves the
// editor and bridge fully initialize under plain `--headless --editor`.
//
// Drives the acceptance criterion end to end through the broker via a real
// MCP client:
//
//   - open the example project's main scene;
//   - add a node and attach a newly created script to it, undo-wrapped;
//   - confirm the change is visible live through gd_scene_tree_get;
//   - undo twice (script attach, then node add) and redo twice;
//   - save the scene and confirm on disk that the node's owner was set, so
//     it actually persists;
//   - validate a deliberately broken script and get line-numbered
//     diagnostics without ever calling gd_play;
//   - exercise project settings, resource create/set-property, asset
//     ingestion, and UID-aware file move/delete;
//   - read back aggregate editor state.
//
// Run with `bun tests/evals/phase3_editor.ts` (needs GODOT_BIN).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p3");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");
const MAIN_TSCN_PATH = join(exampleProject, "main.tscn");

// A well-known minimal valid 1x1 transparent PNG, used to exercise the
// asset-import pipeline without shipping a binary fixture.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  // gd_scene_save (step below) persists the "Added" node into main.tscn with
  // an ext_resource reference to added_script.gd. Cleanup deletes that script
  // but has no tool to un-save a scene, so without restoring the original
  // bytes here a second run opens a main.tscn with a dangling ext_resource
  // and gd_scene_open never produces a valid edited root.
  const originalMainTscn = readFileSync(MAIN_TSCN_PATH);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching headless editor ...");
  // --editor sessions do not honour debug/file_logging/enable_file_logging
  // the way game/export runs do (confirmed empirically, docs/api-gaps.md), so
  // gd_script_validate's log-derived diagnostics need an explicit --log-file;
  // the bridge's log_tail module prefers this over the project setting.
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
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 60_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    record(
      "mcp_tools_listed",
      ["gd_scene_open", "gd_node_add", "gd_script_create", "gd_undo", "gd_editor_get_state"].every((n) => names.includes(n)),
      `${names.length} tools exposed`,
    );

    await runChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    writeFileSync(MAIN_TSCN_PATH, originalMainTscn);
  }

  console.log("\n=== Phase 3 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 3 checks passed.");
}

async function runChecks(client: Client): Promise<void> {
  console.log("\nOpening main.tscn ...");
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  const initial = await callJson(client, "gd_scene_tree_get", {});
  record(
    "scene_open_and_tree_get",
    initial.tree?.name === "Main" && findNode(initial.tree, "Player") !== null,
    `root '${initial.tree?.name}' with Player child present`,
  );

  console.log("\nAdding a node ...");
  const added = await callJson(client, "gd_node_add", { parent_path: ".", type: "Node2D", name: "Added" });
  record("node_add", added.node_path === "Added", `added at node_path '${added.node_path}'`);

  const afterAdd = await callJson(client, "gd_scene_tree_get", {});
  record("node_add_visible_live", findNode(afterAdd.tree, "Added") !== null, "Added node appears in gd_scene_tree_get");

  console.log("\nCreating and attaching a script ...");
  await callJson(client, "gd_script_create", { path: "res://added_script.gd", extends: "Node2D" });
  await callJson(client, "gd_script_attach", { node_path: "Added", script_path: "res://added_script.gd" });
  const afterAttach = await callJson(client, "gd_scene_tree_get", {});
  const addedNode = findNode(afterAttach.tree, "Added");
  record("script_attach_visible_live", addedNode?.script === "res://added_script.gd", `Added.script = ${addedNode?.script}`);

  console.log("\nUndoing the script attach ...");
  const undo1 = await callJson(client, "gd_undo", {});
  const afterUndo1 = await callJson(client, "gd_scene_tree_get", {});
  const nodeAfterUndo1 = findNode(afterUndo1.tree, "Added");
  record(
    "undo_reverses_script_attach",
    undo1.performed === true && nodeAfterUndo1 !== null && nodeAfterUndo1.script === null,
    `performed=${undo1.performed}, Added still present with script=${nodeAfterUndo1?.script}`,
  );

  console.log("\nUndoing the node add (a single further undo) ...");
  const undo2 = await callJson(client, "gd_undo", {});
  const afterUndo2 = await callJson(client, "gd_scene_tree_get", {});
  record(
    "undo_reverses_node_add",
    undo2.performed === true && findNode(afterUndo2.tree, "Added") === null,
    `performed=${undo2.performed}, Added present=${findNode(afterUndo2.tree, "Added") !== null}`,
  );

  console.log("\nRedoing both actions ...");
  await callJson(client, "gd_redo", {});
  await callJson(client, "gd_redo", {});
  const afterRedo = await callJson(client, "gd_scene_tree_get", {});
  const nodeAfterRedo = findNode(afterRedo.tree, "Added");
  record(
    "redo_restores_node_and_script",
    nodeAfterRedo !== null && nodeAfterRedo.script === "res://added_script.gd",
    `Added present=${nodeAfterRedo !== null}, script=${nodeAfterRedo?.script}`,
  );

  console.log("\nSaving the scene and checking the owner was persisted ...");
  await callJson(client, "gd_scene_save", {});
  const tscnText = readFileSync(MAIN_TSCN_PATH, "utf8");
  // Godot's .tscn text format only serializes a [node] block for nodes whose
  // owner is set to the scene root; an unowned node is silently dropped from
  // the save (whitepaper section 6.5's ownership rule), so the block's mere
  // presence on disk is the direct proof that gd_node_add set owner correctly.
  const addedNodeBlock = /\[node name="Added"/.test(tscnText);
  record(
    "save_persists_owner",
    addedNodeBlock,
    addedNodeBlock ? "Added node block present in saved main.tscn" : "Added node block missing from saved main.tscn",
  );

  console.log("\nValidating a deliberately broken script ...");
  await callJson(client, "gd_script_create", {
    path: "res://broken.gd",
    template_source: 'extends Node\nfunc broken(:\n\tpass\n',
  });
  const brokenResult = await callJson(client, "gd_script_validate", { path: "res://broken.gd" });
  const brokenOk =
    brokenResult.valid === false && Array.isArray(brokenResult.diagnostics) && brokenResult.diagnostics.length > 0;
  record(
    "script_validate_reports_broken_script",
    brokenOk,
    // The whole payload on failure, not just the verdict: this check failed on
    // macOS with valid=true and no way to tell from the log whether the
    // subprocess had exited clean or produced no diagnostics at all, which cost
    // a CI round-trip to find out.
    brokenOk
      ? `valid=${brokenResult.valid}, ${brokenResult.diagnostics.length} diagnostic(s), without ever calling gd_play`
      : `expected an invalid verdict with diagnostics, got ${JSON.stringify(brokenResult)}`,
  );

  const validResult = await callJson(client, "gd_script_validate", { path: "res://added_script.gd" });
  record(
    "script_validate_reports_valid_script",
    validResult.valid === true && (validResult.diagnostics?.length ?? -1) === 0,
    `valid=${validResult.valid}, diagnostics=${JSON.stringify(validResult.diagnostics)}`,
  );

  console.log("\nRound-tripping a project setting ...");
  const settingKey = "conduit_test/phase3_marker";
  await callJson(client, "gd_project_set_setting", { key: settingKey, value: "hello" });
  const settingRead = await callJson(client, "gd_project_get_setting", { key: settingKey });
  record("project_setting_round_trip", settingRead.value === "hello", `read back '${settingRead.value}'`);

  console.log("\nCreating a resource and setting a property ...");
  await callJson(client, "gd_resource_create", { class_name: "Resource", path: "res://phase3_test.tres" });
  const setProp = await callJson(client, "gd_resource_set_property", {
    path: "res://phase3_test.tres",
    property: "resource_name",
    value: "phase3",
  });
  record("resource_create_and_set_property", "previous" in setProp, `previous value reported: ${JSON.stringify(setProp.previous)}`);

  console.log("\nIngesting an asset ...");
  const asset = await callJson(client, "gd_asset_add", { path: "res://phase3_icon.png", data_base64: TINY_PNG_BASE64 });
  const importFileExists = existsSync(join(repoRoot, "example-project", "phase3_icon.png.import"));
  record(
    "asset_add_imports",
    asset.bytes_written > 0 && importFileExists,
    `wrote ${asset.bytes_written} bytes, .import present=${importFileExists}`,
  );

  console.log("\nMoving then deleting the test resource ...");
  await callJson(client, "gd_file_move", { from_path: "res://phase3_test.tres", to_path: "res://phase3_test_moved.tres" });
  const movedExists = existsSync(join(repoRoot, "example-project", "phase3_test_moved.tres"));
  const oldGone = !existsSync(join(repoRoot, "example-project", "phase3_test.tres"));
  await callJson(client, "gd_file_delete", { path: "res://phase3_test_moved.tres" });
  const deletedGone = !existsSync(join(repoRoot, "example-project", "phase3_test_moved.tres"));
  record(
    "file_move_and_delete",
    movedExists && oldGone && deletedGone,
    `moved=${movedExists}, old_gone=${oldGone}, deleted=${deletedGone}`,
  );

  console.log("\nReading aggregate editor state ...");
  const state = await callJson(client, "gd_editor_get_state", {});
  const hasMainScene = (state.open_scenes ?? []).some((s: { path: string }) => s.path === "res://main.tscn");
  record(
    "editor_get_state",
    hasMainScene && state.playing === false,
    `open_scenes includes main.tscn=${hasMainScene}, playing=${state.playing}`,
  );

  await cleanupFixtureArtifacts(client, settingKey);
}

// The checks above create real files in example-project/ and set a real
// project setting (gd_project_set_setting always persists to project.godot).
// Clean up through the same tool surface so repeated runs, and `git status`,
// stay quiet. Best-effort: a cleanup failure should not mask check results.
async function cleanupFixtureArtifacts(client: Client, settingKey: string): Promise<void> {
  console.log("\nCleaning up fixture artifacts ...");
  const steps: Array<() => Promise<unknown>> = [
    () => callJson(client, "gd_file_delete", { path: "res://added_script.gd" }),
    () => callJson(client, "gd_file_delete", { path: "res://broken.gd" }),
    () => callJson(client, "gd_file_delete", { path: "res://phase3_icon.png" }),
    // Godot treats a NIL value as an instruction to erase a custom setting.
    () => callJson(client, "gd_project_set_setting", { key: settingKey, value: null }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.log(`  (cleanup step failed, continuing: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

async function connectBroker(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase3-acceptance", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
