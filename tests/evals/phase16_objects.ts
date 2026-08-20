#!/usr/bin/env bun
// Phase 16 live acceptance runner: object handles, the last generic verb.
//
// The gap this closes is the largest single one in the coverage matrix: 3732
// members across 295 Object-derived classes that no node path, class name, or
// res:// path can name, so nothing could hold one across two tool calls. A
// handle is that name. The checks below construct an object, drive it across
// separate calls, capture one another call handed out, pass one as an argument
// to a method on another, and read back a result that proves the work
// happened.
//
// The editor half runs through the broker with --disable-eval, which is the
// point of it: with gd_editor_eval registered, every check here would pass
// whether or not any of this code existed. The game half talks the bridge
// protocol directly to a bare headless game, matching phases 7, 8, and 10 --
// the broker only adopts games it launched itself, and gd_play from a headless
// editor is unproven (docs/api-gaps.md).
//
// Run with `bun tests/evals/phase16_objects.ts` (needs GODOT_BIN).

import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
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

const RUNTIME_DIR = runtimeDir("p16");
const GAME_RUNTIME_DIR = runtimeDir("p16game");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");

const CFG_RES = "res://conduit_phase16.cfg";
const CFG_FILE = join(exampleProject, "conduit_phase16.cfg");
const TILESET_RES = "res://conduit_phase16_tiles.tres";
const TILESET_FILE = join(exampleProject, "conduit_phase16_tiles.tres");

/** Mirrors handles::MAX_HANDLES. The cap check would be meaningless if it drifted. */
const MAX_HANDLES = 64;

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
    throw new Error(`${name} was expected to fail but returned ${text}`);
  }
  return text;
}

/** A tagged handle argument, the form json_to_variant accepts back. */
function handleArg(handle: string): Record<string, unknown> {
  return { __type: "Object", handle };
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);

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
    await constructedObjectChecks(client);
    await editorCaptureChecks(client);
    await refusalChecks(client);
    await capacityChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    for (const path of [CFG_FILE, TILESET_FILE, `${TILESET_FILE}.uid`]) {
      rmSync(path, { force: true });
    }
  }

  await gameBridgeChecks(godot);

  console.log("\n=== Phase 16 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 16 checks passed.");
}

/**
 * The premise of the editor half. If either eval tool is registered, every
 * later check could be passing for the wrong reason.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);

  const expected = ["gd_object", "gd_scene_object"];
  const missing = expected.filter((n) => !names.includes(n));
  record(
    "phase16_tools_registered",
    missing.length === 0,
    missing.length === 0 ? expected.join(", ") : `missing ${missing.join(", ")}`,
  );
}

/**
 * The core claim: an object with no name, built and then driven across three
 * separate tool calls with state carried between them.
 *
 * The disk check is the load-bearing half. Asserting only that get_value
 * returns what set_value wrote would pass against a handler that remembered the
 * value itself; the file proves the calls reached one live ConfigFile.
 */
async function constructedObjectChecks(client: Client): Promise<void> {
  console.log("\nConstructed objects ...");
  await callJson(client, "gd_scene_object", { op: "release_all" });

  const created = await callJson(client, "gd_scene_object", { op: "create", class: "ConfigFile" });
  record(
    "create_returns_a_handle",
    typeof created.handle === "string" && created.handle.startsWith("object:") && created.class === "ConfigFile",
    `created ${created.class} as ${created.handle}`,
  );

  await callJson(client, "gd_scene_node_call", {
    target: created.handle,
    method: "set_value",
    args: ["conduit", "answer", 42],
  });
  const read = await callJson(client, "gd_scene_node_call", {
    target: created.handle,
    method: "get_value",
    args: ["conduit", "answer"],
  });
  record(
    "state_survives_between_calls",
    read.result === 42 && read.target === created.handle,
    `set_value then get_value on ${created.handle} -> ${JSON.stringify(read.result)}`,
  );

  await callJson(client, "gd_scene_node_call", { target: created.handle, method: "save", args: [CFG_RES] });
  const onDisk = existsSync(CFG_FILE) ? readFileSync(CFG_FILE, "utf8") : "";
  record(
    "the_handle_named_a_real_object",
    onDisk.includes("answer=42"),
    onDisk.includes("answer=42") ? `${CFG_RES} contains answer=42` : `${CFG_RES} did not carry the value: ${onDisk.slice(0, 80)}`,
  );

  const listed = await callJson(client, "gd_scene_object", { op: "list" });
  const entry = (listed.handles ?? []).find((h: any) => h.handle === created.handle);
  record(
    "list_reports_the_held_object",
    Boolean(entry) && entry.class === "ConfigFile" && entry.refcounted === true && entry.valid === true,
    `list shows ${listed.count}/${listed.max} held, including ${created.handle} (valid: ${entry?.valid})`,
  );

  const released = await callJson(client, "gd_scene_object", { op: "release", handle: created.handle });
  const afterRelease = await callJson(client, "gd_scene_object", { op: "list" });
  record(
    "release_drops_the_handle",
    released.released === created.handle && !(afterRelease.handles ?? []).some((h: any) => h.handle === created.handle),
    `released ${released.released}, ${afterRelease.count} still held`,
  );

  const gone = await callExpectingError(client, "gd_scene_node_get_property", {
    target: created.handle,
    property: "resource_name",
  });
  record(
    "a_released_handle_is_object_not_found",
    gone.startsWith("object_not_found"),
    `${gone.slice(0, 90)}`,
  );

  const never = await callExpectingError(client, "gd_scene_node_call", { target: "object:999999", method: "get_class" });
  record("an_unminted_handle_is_object_not_found", never.startsWith("object_not_found"), `${never.slice(0, 90)}`);
}

/**
 * Capture: taking a handle on an object another call handed back.
 *
 * The TileSet path is the one that needs no editor UI, so it is the primary
 * check. It also exercises both directions in one flow: a constructed
 * TileSetAtlasSource goes *in* as a method argument, and the source the
 * TileSet hands back comes *out* as a capture.
 */
async function editorCaptureChecks(client: Client): Promise<void> {
  console.log("\nCapture on the editor bridge ...");
  await callJson(client, "gd_resource_create", { class_name: "TileSet", path: TILESET_RES });

  const source = await callJson(client, "gd_scene_object", { op: "create", class: "TileSetAtlasSource" });
  const added = await callJson(client, "gd_resource_call", {
    path: TILESET_RES,
    method: "add_source",
    args: [handleArg(source.handle)],
  });
  record(
    "a_handle_passes_as_a_method_argument",
    typeof added.result === "number" && added.result >= 0,
    `TileSet.add_source(${source.handle}) -> source id ${JSON.stringify(added.result)}`,
  );

  const fetched = await callJson(client, "gd_resource_call", {
    path: TILESET_RES,
    method: "get_source",
    args: [added.result],
    save: false,
    capture: true,
  });
  record(
    "resource_call_captures_what_it_hands_back",
    fetched.captured === true && fetched.handle_class === "TileSetAtlasSource",
    `get_source captured a ${fetched.handle_class} as ${fetched.handle}`,
  );

  // Writing through the captured handle and reading it back proves the capture
  // named the live sub-resource rather than a copy of it.
  await callJson(client, "gd_scene_node_set_property", {
    target: fetched.handle,
    property: "texture_region_size",
    value: { __type: "Vector2i", x: 32, y: 32 },
  });
  const regionSize = await callJson(client, "gd_scene_node_get_property", {
    target: fetched.handle,
    property: "texture_region_size",
  });
  record(
    "a_captured_object_is_the_live_one",
    regionSize.value?.x === 32 && regionSize.value?.y === 32,
    `texture_region_size read back as ${JSON.stringify(regionSize.value)}`,
  );

  // Capture asked for on a value that is not an object is not an error; the
  // response says so, which is what lets a caller tell "nothing to hold" from
  // "here is the handle" without inspecting the value itself.
  const plain = await callJson(client, "gd_scene_node_call", {
    target: "singleton:OS",
    method: "get_name",
    capture: true,
  });
  record(
    "capturing_a_non_object_says_so",
    plain.captured === false && plain.handle === undefined,
    `OS.get_name() -> ${JSON.stringify(plain.result)} with captured: false`,
  );

  // The editor's own selection object: manually managed, handed out rather
  // than constructed, and previously reachable only through gd_editor_eval.
  // Headless is the open question here (docs/api-gaps.md, phase 15), which is
  // why the TileSet checks above stand on their own.
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  const selectResult = await callJson(client, "gd_editor_select", { op: "set", node_paths: ["Player"] });
  await callJson(client, "gd_ping", {});
  const editorState = await callJson(client, "gd_editor_get_state", {});
  const selection = await callJson(client, "gd_scene_node_call", {
    target: "singleton:EditorInterface",
    method: "get_selection",
    capture: true,
  });
  const selected = await callJson(client, "gd_scene_node_call", {
    target: selection.handle,
    method: "get_selected_nodes",
  });
  record(
    "capture_reaches_a_handed_out_object",
    selection.captured === true &&
      selection.handle_class === "EditorSelection" &&
      Array.isArray(selected.result) &&
      selected.result.length === 1,
    `EditorSelection captured as ${selection.handle}; gd_editor_select said ${JSON.stringify(selectResult.selection)}, state said ${JSON.stringify(editorState.selection)}; get_selected_nodes -> ${JSON.stringify(selected.result)}`,
  );

  await callJson(client, "gd_scene_object", { op: "release_all" });
}

/**
 * The two classes create refuses, and why. Both messages have to name the
 * alternative: a refusal that only says no leaves the agent guessing.
 */
async function refusalChecks(client: Client): Promise<void> {
  console.log("\nWhat create refuses ...");

  const node = await callExpectingError(client, "gd_scene_object", { op: "create", class: "Node2D" });
  record(
    "create_refuses_a_node_class",
    node.includes("gd_node_add") || node.includes("gd_tree_mutate"),
    `${node.slice(0, 110)}`,
  );

  const bare = await callExpectingError(client, "gd_scene_object", { op: "create", class: "Object" });
  record("create_refuses_a_non_refcounted_class", bare.includes("RefCounted"), `${bare.slice(0, 110)}`);

  const unknown = await callExpectingError(client, "gd_scene_object", { op: "create", class: "NoSuchClass" });
  record("create_refuses_an_unknown_class", unknown.includes("does not exist"), `${unknown.slice(0, 90)}`);
}

/**
 * The table refuses at capacity rather than evicting. An LRU would let a handle
 * an agent still holds vanish for reasons it cannot observe, so the failure
 * mode here is deliberately a loud one.
 */
async function capacityChecks(client: Client): Promise<void> {
  console.log("\nCapacity ...");
  await callJson(client, "gd_scene_object", { op: "release_all" });

  for (let i = 0; i < MAX_HANDLES; i += 1) {
    await callJson(client, "gd_scene_object", { op: "create", class: "RegEx" });
  }
  const full = await callJson(client, "gd_scene_object", { op: "list" });
  const refused = await callExpectingError(client, "gd_scene_object", { op: "create", class: "RegEx" });
  record(
    "the_table_refuses_past_its_cap",
    full.count === MAX_HANDLES && refused.includes(String(MAX_HANDLES)),
    `${MAX_HANDLES} held, and the next create was refused: ${refused.slice(0, 90)}`,
  );

  const releasedAll = await callJson(client, "gd_scene_object", { op: "release_all" });
  const after = await callJson(client, "gd_scene_object", { op: "create", class: "RegEx" });
  record(
    "release_all_frees_the_slots",
    releasedAll.released === MAX_HANDLES && typeof after.handle === "string",
    `release_all dropped ${releasedAll.released}, and creating again gave ${after.handle}`,
  );
  await callJson(client, "gd_scene_object", { op: "release_all" });
}

/**
 * The game half, and the headline of the phase: the physics query gd_physics
 * had to wrap as dedicated ops, driven generically instead.
 *
 * Talks the bridge protocol directly, matching phases 7, 8, and 10: the broker
 * only adopts games it launched itself, and gd_play from a headless editor is
 * unproven (docs/api-gaps.md). The eval-free claim is carried by the editor
 * half above; what this half proves is that the same handler code reaches the
 * game process.
 */
async function gameBridgeChecks(godot: string): Promise<void> {
  console.log("\nGame bridge ...");
  rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(GAME_RUNTIME_DIR, { recursive: true });

  const game = Bun.spawn(godotCommand(godot, ["--headless", "--path", "example-project", "res://phase8.tscn"], false), {
    cwd: repoRoot,
    env: conduitEnv(GAME_RUNTIME_DIR),
    stdout: "ignore",
    stderr: "ignore",
  });

  let bridge: BridgeClient | null = null;
  try {
    const endpoint = await waitForGameEndpoint(GAME_RUNTIME_DIR, 60_000);
    if (!endpoint) {
      record("game_bound", false, "game bridge endpoint never appeared");
      return;
    }
    bridge = new BridgeClient({ endpoint, defaultTimeoutMs: 10_000 });
    await bridge.connect();
    await bridge.waitForHello(10_000);
    record("game_bound", true, `game bridge bound at ${endpointKey(endpoint)}`);

    const call = async (tool: string, args: Record<string, unknown> = {}): Promise<any> =>
      bridge!.request(tool, args, 15_000);
    const errorCode = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      try {
        await call(tool, args);
        return "";
      } catch (error) {
        return (error as { code?: string }).code ?? "";
      }
    };

    // Not a handle check, but this runner is what found it: gdext refuses to
    // convert a typed array (Array[Node]) into the untyped Array<Variant>, and
    // variant_to_json used to swallow that refusal with unwrap_or_default and
    // report []. Every dynamic call returning a typed array was answering with
    // a wrong value rather than an error (docs/api-gaps.md).
    const children = await call("gd_node_call", { target: "/root/Phase8", method: "get_children" });
    record(
      "a_typed_array_reports_its_elements",
      Array.isArray(children.result) && children.result.length > 0,
      `Node.get_children() -> ${children.result?.length} entries`,
    );

    // Physics needs a few steps before a space state answers.
    await call("gd_wait_frames", { frames: 5 });

    // A pathless resource: World3D is a Resource with no res:// path, so the
    // resource verbs cannot load it and variant_to_json can only stringify it.
    // A handle is the only thing that names it.
    const world = await call("gd_node_call", {
      target: "/root/Phase8/World3D",
      method: "get_world_3d",
      capture: true,
    });
    record(
      "capture_reaches_a_pathless_resource",
      world.captured === true && world.handle_class === "World3D",
      `Node3D.get_world_3d() captured a ${world.handle_class} as ${world.handle}`,
    );

    const space = await call("gd_node_get_property", {
      target: world.handle,
      property: "direct_space_state",
      capture: true,
    });
    record(
      "capture_reaches_the_space_state",
      space.captured === true && String(space.handle_class).includes("PhysicsDirectSpaceState3D"),
      `World3D.direct_space_state captured a ${space.handle_class} as ${space.handle}`,
    );

    // The headline. Two handles at once: a constructed query object goes in as
    // an argument to a method on a captured one. Nothing in the surface could
    // hold either before this phase, which is why gd_physics had to wrap the
    // whole query as a dedicated op.
    const query = await call("gd_object", {
      op: "create",
      class: "PhysicsRayQueryParameters3D",
      properties: {
        from: { __type: "Vector3", x: 0, y: 5, z: 0 },
        to: { __type: "Vector3", x: 0, y: -5, z: 0 },
      },
    });
    const hit = await call("gd_node_call", {
      target: space.handle,
      method: "intersect_ray",
      args: [handleArg(query.handle)],
    });
    const collider = typeof hit.result?.collider === "string" ? hit.result.collider : "";
    record(
      "a_handle_drives_a_query_on_another_handle",
      collider.includes("StaticBody3D") && typeof hit.result?.position?.y === "number",
      `intersect_ray(${query.handle}) on ${space.handle} hit ${collider || JSON.stringify(hit.result)}`,
    );

    // A constructed object accumulating state across four calls, then handing
    // back an object of its own.
    const tool = await call("gd_object", { op: "create", class: "SurfaceTool" });
    await call("gd_node_call", { target: tool.handle, method: "begin", args: [4] });
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      await call("gd_node_call", {
        target: tool.handle,
        method: "add_vertex",
        args: [{ __type: "Vector3", x, y, z: 0 }],
      });
    }
    const committed = await call("gd_node_call", { target: tool.handle, method: "commit", capture: true });
    // commit() returns null on invalid geometry, so the handle has to be
    // asserted before the surface count: without this, a null commit would
    // read as a capture bug rather than as a bad mesh.
    if (committed.captured !== true) {
      record("a_constructed_object_accumulates", false, `commit() captured nothing: ${JSON.stringify(committed.result)}`);
    } else {
      const surfaces = await call("gd_node_call", { target: committed.handle, method: "get_surface_count" });
      record(
        "a_constructed_object_accumulates",
        committed.handle_class === "ArrayMesh" && surfaces.result === 1,
        `SurfaceTool built an ${committed.handle_class} with ${surfaces.result} surface across five calls`,
      );
    }

    // A handle on a manually managed object holds no reference, by design.
    // When something else frees it the handle has to say so rather than
    // dereference a dead pointer, which is the one failure mode here that
    // would be a crash instead of a wrong answer.
    const doomed = await call("gd_node_call", {
      target: "/root/Phase8",
      method: "get_node",
      args: ["Target"],
      capture: true,
    });
    await call("gd_tree_mutate", { op: "free", node_path: "/root/Phase8/Target" });
    await call("gd_wait_frames", { frames: 2 });
    const code = await errorCode("gd_node_get_info", { target: doomed.handle });
    const listed = await call("gd_object", { op: "list" });
    const entry = (listed.handles ?? []).find((h: any) => h.handle === doomed.handle);
    record(
      "a_dangling_handle_reports_its_death",
      code === "object_not_found" && Boolean(entry) && entry.valid === false && entry.refcounted === false,
      `freeing the node left ${doomed.handle} answering ${code || "no error"} and listed as valid: ${entry?.valid}`,
    );

    await call("gd_object", { op: "release_all" });
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
  const client = new Client({ name: "phase16-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
