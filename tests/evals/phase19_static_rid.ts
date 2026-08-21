#!/usr/bin/env bun
// Phase 19 live acceptance runner: the static call, the RID, and the typed
// error -- the three things the coverage matrix's Next section named, all on
// the same call path.
//
// What each part proves:
//
// class:<Class> is the fourth target scheme and the only one that resolves to
// no object, because a static method has no receiver. FileAccess and DirAccess
// are the cluster it opens: both are RefCounted, so gd_object could always
// build one, but open() is static, so the instance a handle held was never an
// open file. The checks below open a file, write to it, close it, and read the
// text back on a second open, which is the whole of the t2:io_page claim.
//
// A RID had no JSON form and stringified to RID(...), so nothing a server
// handed back could be spent on a later call. It is now tagged in both
// directions, with the id carried as a decimal string because an RID is 64-bit
// and JSON.parse rounds above 2^53. The game half cross-checks the generic path
// against gd_physics world_get, which reaches the same value through a
// dedicated op: agreement is what makes the round trip meaningful rather than
// merely successful.
//
// A wrong-typed argument used to panic inside gdext's Object::call and reach
// the client as internal_error, because Object::call is
// try_call(...).unwrap_or_else(|e| panic!). Every dynamic call site now goes
// through try_call, so the argument error arrives as invalid_args naming the
// parameter. That check is the one that fails against the old bridge.
//
// The editor half runs with --disable-eval, which is the point of it: with
// gd_editor_eval registered every check here would pass whether or not any of
// this code existed. The game half talks the bridge protocol directly to a bare
// headless game, matching phases 7, 8, 10, and 16.
//
// Headless throughout, so this runner belongs in ci:phases: physics is real
// under --headless where rendering is not.
//
// Run with `bun tests/evals/phase19_static_rid.ts` (needs GODOT_BIN).

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeClient } from "../../broker/src/ipc-client.ts";
import {
  conduitEnv,
  endpointKey,
  godotCommand,
  killTree,
  repoRoot,
  resolveGodot,
  runtimeDir,
  waitForEditor,
  waitForGameEndpoint,
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p19");
const GAME_RUNTIME_DIR = runtimeDir("p19game");

/** FileAccess.ModeFlags. Named rather than inlined so the calls below read. */
const READ = 1;
const WRITE = 2;

const FILE_PATH = "user://conduit_phase19.txt";
const FILE_TEXT = "phase19 wrote this through a static call";
const DIR_NAME = "conduit_phase19_dir";

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

async function callRaw(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: result.isError === true, text: result.content.find((c) => c.type === "text")?.text ?? "" };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, text } = await callRaw(client, name, args);
  if (isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

/** A tagged RID, as it arrives and as it is spent. */
function isTaggedRid(value: unknown): boolean {
  const rid = value as { __type?: string; id?: unknown };
  return rid?.__type === "RID" && typeof rid.id === "string" && /^\d+$/.test(rid.id);
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase19-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

/**
 * The premise. With gd_editor_eval registered, every check below could pass
 * whether or not the class scheme or the RID form existed.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
}

/**
 * The whole of the t2:io_page claim: a static factory hands back an object, the
 * handle survives to later calls, and the file is really on disk because a
 * second open reads back what the first one wrote.
 */
async function fileAccessChecks(client: Client): Promise<void> {
  console.log("\nStatic calls: FileAccess ...");

  const opened = await callJson(client, "gd_scene_node_call", {
    target: "class:FileAccess",
    method: "open",
    args: [FILE_PATH, WRITE],
    capture: true,
  });
  const writeHandle = typeof opened.handle === "string" ? opened.handle : null;
  record(
    "a_static_call_returns_an_object",
    writeHandle !== null && opened.handle_class === "FileAccess" && opened.target === "class:FileAccess",
    writeHandle === null
      ? `no handle in ${JSON.stringify(opened)}`
      : `FileAccess.open(WRITE) -> ${opened.handle_class} as ${writeHandle}`,
  );
  if (writeHandle === null) {
    return;
  }

  await callJson(client, "gd_scene_node_call", { target: writeHandle, method: "store_string", args: [FILE_TEXT] });
  await callJson(client, "gd_scene_node_call", { target: writeHandle, method: "close" });

  const reopened = await callJson(client, "gd_scene_node_call", {
    target: "class:FileAccess",
    method: "open",
    args: [FILE_PATH, READ],
    capture: true,
  });
  const readHandle = reopened.handle as string;
  const text = await callJson(client, "gd_scene_node_call", { target: readHandle, method: "get_as_text" });
  record(
    "the_file_holds_what_the_handle_wrote",
    text.result === FILE_TEXT,
    `second open + get_as_text -> ${JSON.stringify(text.result)}`,
  );
  await callJson(client, "gd_scene_node_call", { target: readHandle, method: "close" });

  // The other static shape on the same class: a predicate that never wanted an
  // instance at all.
  const exists = await callJson(client, "gd_scene_node_call", {
    target: "class:FileAccess",
    method: "file_exists",
    args: [FILE_PATH],
  });
  record("a_static_predicate_answers", exists.result === true, `FileAccess.file_exists -> ${exists.result}`);
}

/** The other half of the cluster the rule names. */
async function dirAccessChecks(client: Client): Promise<void> {
  console.log("\nStatic calls: DirAccess ...");

  const dir = await callJson(client, "gd_scene_node_call", {
    target: "class:DirAccess",
    method: "open",
    args: ["user://"],
    capture: true,
  });
  const handle = dir.handle as string;
  await callJson(client, "gd_scene_node_call", { target: handle, method: "make_dir", args: [DIR_NAME] });
  const made = await callJson(client, "gd_scene_node_call", {
    target: handle,
    method: "dir_exists",
    args: [DIR_NAME],
  });
  record(
    "a_directory_handle_does_work_that_persists",
    dir.handle_class === "DirAccess" && made.result === true,
    `DirAccess.open(user://) -> ${dir.handle_class}, make_dir + dir_exists -> ${made.result}`,
  );
  await callJson(client, "gd_scene_node_call", { target: handle, method: "remove", args: [DIR_NAME] });
}

/**
 * The refusals that make the scheme usable rather than merely possible. Naming
 * an instance method on a class is the likely mistake, and dispatching blind
 * would answer it with an argument error about the class name.
 */
async function classRefusalChecks(client: Client): Promise<void> {
  console.log("\nWhat a class target refuses ...");

  const instance = await callRaw(client, "gd_scene_node_call", {
    target: "class:FileAccess",
    method: "get_as_text",
  });
  record(
    "an_instance_method_through_a_class_is_named_as_such",
    instance.isError && instance.text.includes("invalid_args") && instance.text.includes("instance method"),
    `FileAccess.get_as_text via class: -> ${instance.text}`,
  );

  const absent = await callRaw(client, "gd_scene_node_call", {
    target: "class:FileAccess",
    method: "no_such_method_exists",
  });
  record(
    "an_absent_method_stays_call_failed",
    absent.isError && absent.text.includes("call_failed"),
    `FileAccess.no_such_method_exists -> ${absent.text}`,
  );

  const notAClass = await callRaw(client, "gd_scene_node_call", { target: "class:NotAClass", method: "open" });
  record(
    "an_unknown_class_is_rejected",
    notAClass.isError && notAClass.text.includes("invalid_args"),
    `class:NotAClass -> ${notAClass.text}`,
  );

  // A class is not an object, so every tool that reaches one refuses it, with a
  // message that says where to go instead.
  const asObject = await callRaw(client, "gd_scene_node_get_property", {
    target: "class:FileAccess",
    property: "name",
  });
  record(
    "a_class_target_is_refused_by_the_tools_that_want_an_object",
    asObject.isError && asObject.text.includes("invalid_args") && asObject.text.includes("gd_classdb"),
    `gd_scene_node_get_property on class:FileAccess -> ${asObject.text}`,
  );
}

/** Discoverability: the flag that says which methods the scheme accepts. */
async function classdbStaticFlagChecks(client: Client): Promise<void> {
  console.log("\nDiscoverability ...");
  const methods = await callJson(client, "gd_classdb", { op: "methods", class: "FileAccess", limit: 300 });
  const items = (methods.items ?? []) as Array<{ name: string; static?: boolean }>;
  const open = items.find((m) => m.name === "open");
  const instance = items.find((m) => m.name === "get_as_text");
  record(
    "gd_classdb_says_which_methods_are_static",
    open?.static === true && instance?.static === false,
    `FileAccess.open static=${open?.static}, FileAccess.get_as_text static=${instance?.static}`,
  );
}

/**
 * The RID round trip. A space is created, made active, read back, and freed:
 * four calls spending the same id, with an observable state change in the
 * middle, so the value is proven to name the same space rather than merely to
 * survive a serialisation.
 */
async function ridChecks(client: Client): Promise<void> {
  console.log("\nRIDs ...");

  const created = await callJson(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_create",
  });
  const rid = created.result;
  record("a_returned_rid_is_tagged", isTaggedRid(rid), `space_create -> ${JSON.stringify(rid)}`);
  if (!isTaggedRid(rid)) {
    return;
  }

  await callJson(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_set_active",
    args: [rid, true],
  });
  const active = await callJson(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_is_active",
    args: [rid],
  });
  record(
    "a_returned_rid_can_be_spent",
    active.result === true,
    `space_set_active(rid, true) then space_is_active(rid) -> ${active.result}`,
  );

  await callJson(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "free_rid",
    args: [rid],
  });
  record("a_spent_rid_can_be_freed", true, `free_rid(${(rid as { id: string }).id}) returned`);

  // An id an agent made up is a plausible mistake now that ids are writable.
  // The engine refuses it rather than dereferencing; what this asserts is that
  // the bridge is still answering afterwards, not the shape of the refusal.
  const fabricated = await callRaw(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_is_active",
    args: [{ __type: "RID", id: "12345" }],
  });
  const alive = await callRaw(client, "gd_ping");
  record(
    "a_fabricated_rid_does_not_take_the_bridge_down",
    !alive.isError,
    `fabricated rid -> ${fabricated.text}; bridge still answers gd_ping`,
  );
}

/**
 * The reporting defect phase 18 recorded. Before try_call this was
 * `internal_error: internal error: handler panicked`, because gdext's
 * Object::call panics on an argument mismatch and the dispatcher's catch_unwind
 * contained it. Asserting the exact code is what makes this falsifiable against
 * the old bridge.
 */
async function typedErrorChecks(client: Client): Promise<void> {
  console.log("\nThe typed argument error ...");

  const wrongType = await callRaw(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_is_active",
    args: ["not-an-rid"],
  });
  record(
    "a_wrong_typed_argument_is_invalid_args",
    wrongType.isError && wrongType.text.includes("invalid_args") && !wrongType.text.includes("internal_error"),
    `space_is_active("not-an-rid") -> ${wrongType.text}`,
  );
  record(
    "the_argument_error_names_the_call",
    wrongType.text.includes("space_is_active"),
    `error names the method: ${wrongType.text.includes("space_is_active")}`,
  );

  const wrongCount = await callRaw(client, "gd_scene_node_call", {
    target: "singleton:PhysicsServer2D",
    method: "space_set_active",
    args: [],
  });
  record(
    "a_wrong_argument_count_is_invalid_args_too",
    wrongCount.isError && wrongCount.text.includes("invalid_args") && !wrongCount.text.includes("internal_error"),
    `space_set_active() with no arguments -> ${wrongCount.text}`,
  );
}

/**
 * AREA_PARAM_GRAVITY by name rather than by ordinal: the enum is the engine's
 * to number, and a hard-coded index that shifted would make the comparison
 * below pass or fail for a reason that has nothing to do with RIDs.
 */
async function areaParamGravity(
  call: (tool: string, args?: Record<string, unknown>) => Promise<any>,
): Promise<number> {
  const constants = await call("gd_classdb", { op: "constants", class: "PhysicsServer2D", limit: 400 });
  const entry = (constants.items ?? []).find((c: { name: string }) => c.name === "AREA_PARAM_GRAVITY");
  if (typeof entry?.value !== "number") {
    throw new Error("PhysicsServer2D has no AREA_PARAM_GRAVITY constant");
  }
  return entry.value;
}

/**
 * The game half. The grammar and the RID form are shared code, so what this
 * proves is that the same handlers reach the game process under the other tool
 * name -- and, for the RID, that the generic path agrees with the dedicated op
 * that reads the same value.
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

    const opened = await call("gd_node_call", {
      target: "class:FileAccess",
      method: "open",
      args: [FILE_PATH, READ],
      capture: true,
    });
    const text = await call("gd_node_call", { target: opened.handle, method: "get_as_text" });
    record(
      "the_class_scheme_reaches_the_game_process",
      opened.handle_class === "FileAccess" && text.result === FILE_TEXT,
      `gd_node_call class:FileAccess open + get_as_text -> ${JSON.stringify(text.result)}`,
    );
    await call("gd_node_call", { target: opened.handle, method: "close" });

    // The world's space RID, reached generically: a property read that captures
    // the World2D, a second read for the RID off that handle, and a server call
    // that spends it. gd_physics world_get reads the same value through a
    // dedicated op, so the two answers must agree.
    const world = await call("gd_node_get_property", { target: "/root", property: "world_2d", capture: true });
    const space = await call("gd_node_get_property", { target: world.handle, property: "space" });
    const rid = space.value;
    record("a_property_read_hands_back_a_spendable_rid", isTaggedRid(rid), `World2D.space -> ${JSON.stringify(rid)}`);

    const gravityParam = await areaParamGravity(call);
    const generic = await call("gd_node_call", {
      target: "singleton:PhysicsServer2D",
      method: "area_get_param",
      args: [rid, gravityParam],
    });
    const dedicated = await call("gd_physics", { op: "world_get", dimension: "2d" });
    record(
      "the_generic_rid_path_agrees_with_gd_physics",
      typeof generic.result === "number" && generic.result === dedicated.gravity,
      `area_get_param(space, GRAVITY=${gravityParam}) -> ${generic.result}, gd_physics world_get -> ${dedicated.gravity}`,
    );

    const code = await errorCode("gd_node_call", {
      target: "singleton:PhysicsServer2D",
      method: "space_is_active",
      args: ["not-an-rid"],
    });
    record(
      "the_game_bridge_reports_a_bad_argument_the_same_way",
      code === "invalid_args",
      `space_is_active("not-an-rid") -> ${code || "no error"}`,
    );

    // Cleanup, and one more static shape while it is here: a static method
    // that takes no instance and returns nothing.
    await call("gd_node_call", { target: "class:DirAccess", method: "remove_absolute", args: [FILE_PATH] });
  } finally {
    bridge?.close();
    killTree(game);
    await game.exited.catch(() => {});
    rmSync(GAME_RUNTIME_DIR, { recursive: true, force: true });
  }
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
  const editor = Bun.spawn(godotCommand(godot, ["--headless", "--editor", "--path", "example-project"], false), {
    cwd: repoRoot,
    env: conduitEnv(RUNTIME_DIR),
    stdout: "ignore",
    stderr: "ignore",
  });

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 90_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker(["--disable-eval"]);
    await assertEvalIsGone(client);
    await fileAccessChecks(client);
    await dirAccessChecks(client);
    await classRefusalChecks(client);
    await classdbStaticFlagChecks(client);
    await ridChecks(client);
    await typedErrorChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  await gameBridgeChecks(godot);

  console.log("\n=== Phase 19 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 19 checks passed.");
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
