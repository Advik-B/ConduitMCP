#!/usr/bin/env bun
// Phase 17 live acceptance runner: a signal on anything the grammar can name.
//
// The two signal tools were the last generic verbs that had never learned the
// target grammar, which is the whole of what the coverage matrix still graded
// T2 in the class reference: 140 signals across singleton-, object-, and
// resource-kind classes. `await` was worse than late -- it generated
// `return await Signal(get_node(path), signal)` and handed it to the evaluation
// runner, so it was limited to node paths by construction and ran the eval
// machinery even under --disable-eval.
//
// That is what makes these checks falsifiable rather than decorative. Awaiting
// on `object:<n>` or `singleton:<Class>` cannot be the old implementation in
// disguise: the generated snippet had a `get_node` in it, so a target that is
// not a node path could never have reached it.
//
// The editor half runs through the broker with --disable-eval; the game half
// talks the bridge protocol directly to a bare headless game, matching phases
// 8, 10 and 16 (the broker only adopts games it launched itself, and gd_play
// from a headless editor is unproven -- docs/api-gaps.md).
//
// Run with `bun tests/evals/phase17_signals.ts` (needs GODOT_BIN).

import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

const RUNTIME_DIR = runtimeDir("p17");
const GAME_RUNTIME_DIR = runtimeDir("p17game");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");

const SCENE_RES = "res://conduit_phase17.tscn";
const SCENE_FILE = join(exampleProject, "conduit_phase17.tscn");
const CURVE_RES = "res://conduit_phase17_curve.tres";
const CURVE_FILE = join(exampleProject, "conduit_phase17_curve.tres");

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

async function callExpectingError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!result.isError) {
    throw new Error(`${name} was expected to fail but returned ${text}`);
  }
  return text;
}

/** Signal names from a list response, whichever shape the bridge answered with. */
function signalNames(listed: any): string[] {
  return (listed.signals ?? []).map((s: any) => String(s.name));
}

function connectionCount(listed: any, signal: string): number {
  const entry = (listed.signals ?? []).find((s: any) => s.name === signal);
  return entry ? Number(entry.connection_count) : -1;
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  await gameBridgeChecks(godot);
  await editorChecks(godot);

  console.log("\n=== Phase 17 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 17 checks passed.");
}

/**
 * The game half. Every await here is on a target the eval-backed implementation
 * could not have expressed, except the last one, which is the node case kept to
 * prove the old path still answers the same way.
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
      bridge!.request(tool, args, 20_000);
    const errorCode = async (tool: string, args: Record<string, unknown>): Promise<string> => {
      try {
        await call(tool, args);
        return "";
      } catch (error) {
        return (error as { code?: string }).code ?? "";
      }
    };

    // The SceneTree is object-kind: no path names it, and before handles
    // nothing could hold one. It is also the class whose signals an agent most
    // often wants (node_added, process_frame).
    const tree = await call("gd_node_call", { target: "/root/Phase8", method: "get_tree", capture: true });
    const listed = await call("gd_signal", { target: tree.handle, op: "list" });
    const names = signalNames(listed);
    record(
      "an_object_handle_lists_its_signals",
      tree.handle_class === "SceneTree" && names.includes("process_frame") && names.includes("node_added"),
      `${tree.handle} (${tree.handle_class}) declares ${names.length} signals including process_frame and node_added`,
    );

    const framed = await call("gd_signal", { target: tree.handle, op: "await", signal: "process_frame" });
    record(
      "await_settles_on_an_object_handle",
      framed.signal === "process_frame" && framed.target === tree.handle && Array.isArray(framed.args),
      `awaited ${tree.handle}.process_frame -> ${JSON.stringify(framed.args)}`,
    );

    // A SceneTreeTimer exists only as a returned object: it has no path, no
    // res:// name, and is not a singleton. Awaiting its timeout is the shape an
    // agent actually wants and could not previously write.
    const timer = await call("gd_node_call", {
      target: tree.handle,
      method: "create_timer",
      args: [0.2],
      capture: true,
    });
    const timedOut = await call("gd_signal", { target: timer.handle, op: "await", signal: "timeout" });
    record(
      "await_settles_on_a_returned_object",
      timer.handle_class === "SceneTreeTimer" && timedOut.signal === "timeout",
      `create_timer(0.2) captured ${timer.handle} and its timeout fired`,
    );

    // Arity. A custom Rust callable reports no argument count, which is what
    // lets one implementation connect to signals of every shape; a #[func]
    // method has a fixed arity and Godot refuses to connect it to a wider
    // signal. node_added carries one argument, so this is where that claim is
    // measured rather than assumed.
    const pending = call("gd_signal", { target: tree.handle, op: "await", signal: "node_added" });
    await call("gd_wait_frames", { frames: 1 });
    await call("gd_tree_mutate", {
      op: "add_node",
      class: "Node2D",
      parent_path: "/root/Phase8",
      name: "Phase17Added",
    });
    const added = await pending;
    record(
      "await_carries_a_signals_arguments",
      Array.isArray(added.args) && added.args.length === 1 && added.args[0] !== null && added.value === added.args[0],
      `node_added delivered ${added.args.length} argument(s): ${JSON.stringify(added.args)}`,
    );

    // A singleton's signals. Input.joy_connection_changed cannot fire in a
    // headless game with no joypads, so the connection count is a stable
    // reading of connect and disconnect.
    const before = await call("gd_signal", { target: "singleton:Input", op: "list", signal: "joy_connection_changed" });
    await call("gd_signal", {
      op: "connect",
      target: "singleton:Input",
      signal: "joy_connection_changed",
      receiver: "/root/Phase8",
      method: "echo",
    });
    const during = await call("gd_signal", { target: "singleton:Input", op: "list", signal: "joy_connection_changed" });
    await call("gd_signal", {
      op: "disconnect",
      target: "singleton:Input",
      signal: "joy_connection_changed",
      receiver: "/root/Phase8",
      method: "echo",
    });
    const after = await call("gd_signal", { target: "singleton:Input", op: "list", signal: "joy_connection_changed" });
    const counts = [before, during, after].map((r) => connectionCount(r, "joy_connection_changed"));
    const [b, d, a] = counts as [number, number, number];
    record(
      "a_singleton_signal_connects_and_disconnects",
      b >= 0 && d === b + 1 && a === b,
      `Input.joy_connection_changed connection count went ${b} -> ${d} -> ${a}`,
    );

    // Arity two, on a singleton, driven by emit. joy_connection_changed takes
    // (device: int, connected: bool) and never fires on its own here, so this
    // is deterministic. It is also where `value` earns its shape: GDScript
    // await yields an array once a signal carries more than one argument, and
    // the eval-backed implementation put that array in `value`, so reporting
    // the first argument instead would have been a silent divergence.
    const twoArgs = call("gd_signal", {
      target: "singleton:Input",
      op: "await",
      signal: "joy_connection_changed",
    });
    await call("gd_wait_frames", { frames: 1 });
    await call("gd_signal", {
      target: "singleton:Input",
      op: "emit",
      signal: "joy_connection_changed",
      args: [0, true],
    });
    const pair = await twoArgs;
    record(
      "await_matches_gdscript_for_a_two_argument_signal",
      Array.isArray(pair.args) &&
        pair.args.length === 2 &&
        pair.args[0] === 0 &&
        pair.args[1] === true &&
        Array.isArray(pair.value) &&
        pair.value.length === 2 &&
        pair.type === "ARRAY",
      `joy_connection_changed(0, true) delivered args ${JSON.stringify(pair.args)} and value ${JSON.stringify(pair.value)} (${pair.type})`,
    );

    // emit and await together on a node target, which is the one combination
    // the eval-backed implementation could express: it has to keep answering.
    const renamed = call("gd_signal", { node_path: "/root/Phase8/Anim", op: "await", signal: "renamed" });
    await call("gd_wait_frames", { frames: 1 });
    await call("gd_signal", { node_path: "/root/Phase8/Anim", op: "emit", signal: "renamed" });
    const emitted = await renamed;
    record(
      "emit_and_await_still_answer_on_a_node_path",
      emitted.signal === "renamed" && emitted.node_path === "/root/Phase8/Anim",
      `emitted renamed on ${emitted.node_path} and the await settled`,
    );

    // Phase 16's rule, applied to a pending op: a handle whose object is gone
    // reports its death rather than being dereferenced.
    const doomed = await call("gd_node_call", {
      target: "/root/Phase8",
      method: "get_node",
      args: ["Target"],
      capture: true,
    });
    await call("gd_tree_mutate", { op: "free", node_path: "/root/Phase8/Target" });
    await call("gd_wait_frames", { frames: 2 });
    const code = await errorCode("gd_signal", { target: doomed.handle, op: "await", signal: "renamed" });
    record(
      "awaiting_a_dead_emitter_reports_object_not_found",
      code === "object_not_found",
      `awaiting on ${doomed.handle} after freeing the node answered ${code || "no error"}`,
    );

    await call("gd_object", { op: "release_all" });
  } finally {
    bridge?.close();
    killTree(game);
    await game.exited.catch(() => {});
    rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  }
}

/**
 * The editor half, with --disable-eval. With gd_editor_eval registered every
 * check below could pass whether or not any of this code existed.
 */
async function editorChecks(godot: string): Promise<void> {
  console.log("\nEditor bridge (--disable-eval) ...");
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const path of [SCENE_FILE, `${SCENE_FILE}.uid`, CURVE_FILE, `${CURVE_FILE}.uid`]) {
    rmSync(path, { force: true });
  }

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
    await editorSelectionChecks(client);
    await resourceSignalChecks(client);
    await honestConnectChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    for (const path of [SCENE_FILE, `${SCENE_FILE}.uid`, CURVE_FILE, `${CURVE_FILE}.uid`]) {
      rmSync(path, { force: true });
    }
  }
}

/** The premise of the editor half. */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
}

/**
 * EditorSelection is object-kind, handed out by EditorInterface and named by
 * nothing else. Awaiting its selection_changed is the edit-time shape of the
 * whole phase, and it needs two requests in flight at once.
 */
async function editorSelectionChecks(client: Client): Promise<void> {
  console.log("\nEditor selection ...");
  await callJson(client, "gd_scene_object", { op: "release_all" });
  await callJson(client, "gd_scene_create", { path: SCENE_RES, root_type: "Node2D", root_name: "Phase17" });
  await callJson(client, "gd_node_add", { parent_path: ".", type: "Node2D", name: "Marker" });
  await callJson(client, "gd_scene_save", {});

  const selection = await callJson(client, "gd_scene_node_call", {
    target: "singleton:EditorInterface",
    method: "get_selection",
    capture: true,
  });
  const listed = await callJson(client, "gd_scene_signal", { target: selection.handle, op: "list" });
  record(
    "an_editor_object_lists_its_signals",
    selection.handle_class === "EditorSelection" && signalNames(listed).includes("selection_changed"),
    `${selection.handle} (${selection.handle_class}) declares selection_changed`,
  );

  await callJson(client, "gd_editor_select", { op: "clear" });
  const pending = callJson(client, "gd_scene_signal", {
    target: selection.handle,
    op: "await",
    signal: "selection_changed",
  });
  // The await has to be in flight before the trigger, and the broker
  // correlates by request id rather than serialising, so the two overlap.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await callJson(client, "gd_editor_select", { op: "set", node_paths: ["Marker"] });
  const fired = await pending;
  record(
    "await_settles_in_the_editor_with_eval_disabled",
    fired.signal === "selection_changed" && fired.target === selection.handle,
    `selecting Marker settled the await on ${selection.handle}`,
  );
}

/**
 * A resource's signals are the member kind the resource verbs never reached.
 * The res:// path enters the target grammar as a handle, through
 * ResourceLoader.load with capture, and gd_resource_set_property then acts on
 * the same cached instance -- which is what makes the `changed` signal fire on
 * the object the handle names rather than on a second copy.
 */
async function resourceSignalChecks(client: Client): Promise<void> {
  console.log("\nResource signals ...");
  await callJson(client, "gd_resource_create", { path: CURVE_RES, class_name: "Curve" });

  const curve = await callJson(client, "gd_scene_node_call", {
    target: "singleton:ResourceLoader",
    method: "load",
    args: [CURVE_RES],
    capture: true,
  });
  const listed = await callJson(client, "gd_scene_signal", { target: curve.handle, op: "list" });
  record(
    "a_resource_handle_lists_its_signals",
    curve.handle_class === "Curve" && signalNames(listed).includes("changed"),
    `${CURVE_RES} captured as ${curve.handle} (${curve.handle_class}) declaring changed`,
  );

  // The trigger goes through the res:// path, not through the handle, which is
  // what proves the two name one instance: ResourceLoader caches, so
  // gd_resource_call reaches the object the capture is holding. It calls
  // emit_changed rather than writing a property because not every setter
  // notifies, and which setters do is not what this check is about.
  const pending = callJson(client, "gd_scene_signal", { target: curve.handle, op: "await", signal: "changed" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await callJson(client, "gd_resource_call", { path: CURVE_RES, method: "emit_changed", save: false });
  const fired = await pending;
  record(
    "a_resource_signal_is_reachable_at_edit_time",
    fired.signal === "changed" && fired.target === curve.handle,
    `firing changed through the res:// path settled the await on ${curve.handle}`,
  );

  // The edit-time emit op, which the game half exercises on a node and this
  // half exercises on an object handle.
  const awaited = callJson(client, "gd_scene_signal", { target: curve.handle, op: "await", signal: "changed" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const emitted = await callJson(client, "gd_scene_signal", {
    target: curve.handle,
    op: "emit",
    signal: "changed",
  });
  const settled = await awaited;
  record(
    "emit_answers_at_edit_time_on_a_handle",
    emitted.emitted === true && emitted.undoable === false && settled.signal === "changed",
    `emitting changed on ${curve.handle} settled its own await, reported undoable: ${emitted.undoable}`,
  );
}

/**
 * The honesty rule. A persisted connection needs a scene file to serialize
 * into and an edited-scene history to own it; a singleton source has neither,
 * so the response says so and the saved scene stays clean. A gd_undo that
 * claimed to revert this would be the misreporting failure this repository
 * rejects elsewhere.
 */
async function honestConnectChecks(client: Client): Promise<void> {
  console.log("\nNon-node connects ...");
  const connected = await callJson(client, "gd_scene_signal", {
    op: "connect",
    target: "singleton:Input",
    signal: "joy_connection_changed",
    receiver: "Marker",
    method: "set_process",
  });
  record(
    "a_non_node_connect_reports_itself_unpersisted",
    connected.connected === true && connected.persisted === false && connected.undoable === false,
    `connecting Input.joy_connection_changed reported persisted: ${connected.persisted}, undoable: ${connected.undoable}`,
  );

  await callJson(client, "gd_scene_save", {});
  const scene = readFileSync(SCENE_FILE, "utf8");
  record(
    "an_unpersisted_connection_is_not_written_to_the_scene",
    !scene.includes("[connection"),
    scene.includes("[connection")
      ? `the saved scene carried a connection it cannot own: ${scene}`
      : "the saved scene carries no connection section",
  );

  await callJson(client, "gd_scene_signal", {
    op: "disconnect",
    target: "singleton:Input",
    signal: "joy_connection_changed",
    receiver: "Marker",
    method: "set_process",
  });
  const gone = await callExpectingError(client, "gd_scene_signal", {
    op: "disconnect",
    target: "singleton:Input",
    signal: "joy_connection_changed",
    receiver: "Marker",
    method: "set_process",
  });
  record(
    "disconnect_severs_the_live_connection",
    gone.startsWith("invalid_args"),
    `a second disconnect answered ${gone.slice(0, 90)}`,
  );

  // A node-to-node connect is untouched by any of this: still CONNECT_PERSIST,
  // still undo-wrapped, still saved.
  const persisted = await callJson(client, "gd_scene_signal", {
    op: "connect",
    target: "Marker",
    signal: "renamed",
    receiver: ".",
    method: "set_process",
  });
  await callJson(client, "gd_scene_save", {});
  const withConnection = readFileSync(SCENE_FILE, "utf8");
  record(
    "a_node_to_node_connect_is_still_persisted",
    persisted.persisted === true && persisted.undoable === true && withConnection.includes("[connection"),
    `Marker.renamed -> .set_process reported persisted: ${persisted.persisted} and the scene carries a connection section`,
  );
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase17-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
