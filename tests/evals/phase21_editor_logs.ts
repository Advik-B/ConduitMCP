#!/usr/bin/env bun
// Phase 21 live acceptance runner: the editor's error stream reaches a client.
//
// The gap phase 20 found rather than predicted. The engine's error convention
// is to print and return, so an editor-side call that fails softly arrives as a
// successful tool call carrying a useless value -- phase 20's RID(0), a
// well-formed RID naming nothing. gd_get_logs and gd_get_errors registered only
// in the game personality, so the message explaining it went to a stream no MCP
// client is attached to. The phase 20 runner could quote it only because it
// spawns the editor itself and drains its pipes.
//
// Two things make this more than a registration. The editor cannot find its own
// log: --log-file is consumed by the engine's argument parsing and never
// reaches OS.get_cmdline_args(), which is why the pre-phase-21 cmdline scan
// never once fired and the handler silently read user://logs/godot.log -- where
// the *game* writes. So the launcher says where the log is (CONDUIT_LOG_FILE),
// and the resolver refuses to fall back to the game's file. Both halves are
// asserted below, the second with a sentinel line planted in that game log: a
// check that only looked for "an error came back" would pass while reading the
// wrong file.
//
// Headless throughout, and with --disable-eval, so nothing here is eval in
// disguise. Run with `bun tests/evals/phase21_editor_logs.ts` (needs GODOT_BIN).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  endpointKey,
  godotCommand,
  killTree,
  repoRoot,
  resolveGodot,
  runtimeDir,
  waitForEditor,
} from "./harness.ts";

// The two editors never run at once: one bridge listener serves one broker at a
// time, so the no-log editor gets its own runtime directory and its own broker
// after the first is gone (docs/api-gaps.md).
const RUNTIME_DIR = runtimeDir("p21");
const RUNTIME_DIR_NOLOG = runtimeDir("p21-nolog");
const RUNTIME_DIR_LAUNCH = runtimeDir("p21-launch");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");

// Planted in the *game's* log file, which is the file a resolver that fell back
// to the project setting would read. It must never appear in an editor answer.
const SENTINEL = "CONDUIT_PHASE21_SENTINEL_THIS_IS_THE_GAME_LOG";

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

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await call(client, name, args);
  const text = textOf(result);
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

async function connectBroker(rtDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), "--disable-eval"],
    env: conduitEnv(rtDir),
  });
  const client = new Client({ name: "phase21-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

function spawnEditor(godot: string, rtDir: string, logPath: string | null): ReturnType<typeof Bun.spawn> {
  const args = ["--headless", "--editor", "--path", "example-project"];
  if (logPath) {
    args.push("--log-file", logPath);
  }
  // CONDUIT_LOG_FILE, not the launch argument, is what the bridge reads: the
  // engine consumes --log-file before OS.get_cmdline_args() can report it. Both
  // are passed together because they mean different things to different
  // readers, exactly as gd_editor_launch passes them.
  const env = logPath ? conduitEnv(rtDir, { CONDUIT_LOG_FILE: logPath }) : conduitEnv(rtDir);
  if (!logPath) {
    delete (env as Record<string, string>).CONDUIT_LOG_FILE;
  }
  return Bun.spawn(godotCommand(godot, args, false), { cwd: repoRoot, env, stdout: "ignore", stderr: "ignore" });
}

/** The lines a reader outside the editor process can see in the editor's log. */
function errorLinesOnDisk(): string[] {
  try {
    return readFileSync(EDITOR_LOG, "utf8")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.includes("ERROR") || line.includes("WARNING"));
  } catch {
    return [];
  }
}

/**
 * The premise. With gd_editor_eval registered, an agent could read the log by
 * evaluating GDScript and every check below would prove nothing about the tool.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  const both = names.includes("gd_editor_get_logs") && names.includes("gd_editor_get_errors");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
  record("log_tools_registered", both, "gd_editor_get_logs and gd_editor_get_errors are on the editor bridge");
}

/**
 * Plant the sentinel in the game's log file, which is what the editor resolver
 * refuses to fall back to. Returns the path so the failure detail can name it.
 */
async function plantSentinel(client: Client): Promise<string> {
  const globalized = await callJson(client, "gd_scene_node_call", {
    target: "singleton:ProjectSettings",
    method: "globalize_path",
    args: ["user://logs/godot.log"],
  });
  const path = String(globalized.result ?? "");
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, `${existing}ERROR: ${SENTINEL}\n`);
  return path;
}

async function loggedEditorChecks(client: Client): Promise<void> {
  await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
  const gameLog = await plantSentinel(client);
  console.log(`\nSentinel planted in the game log at ${gameLog}`);

  // Startup wrote plenty; both cursors start where the interesting part begins.
  await call(client, "gd_editor_get_errors", {});
  await call(client, "gd_editor_get_logs", {});

  console.log("\nCalling a method that fails softly ...");
  // get_node prints and returns null where get_node_or_null is silent, so the
  // call succeeds and the reason is only in the log: the shape phase 20 met.
  const soft = await callJson(client, "gd_scene_node_call", { target: ".", method: "get_node", args: ["Missing"] });
  record(
    "the_soft_failure_reports_success",
    soft.result === null,
    `gd_scene_node_call get_node('Missing') returned result=${JSON.stringify(soft.result)} with no error`,
  );

  // Read the file from THIS process first. If the error is on disk here and the
  // tool answers nothing, the editor cannot read its own log -- the phase 3
  // note's claim, and the reason this check is permanent rather than a probe.
  const onDiskBefore = errorLinesOnDisk();
  const errors = await callJson(client, "gd_editor_get_errors", {});
  const returned: string[] = errors.errors ?? [];
  const notFound = returned.find((line) => line.includes("Node not found") && line.includes("Missing"));
  record(
    "an_editor_side_soft_error_reaches_the_client",
    notFound !== undefined,
    notFound ? `gd_editor_get_errors returned: ${notFound.slice(0, 90)}...` : `nothing came back: ${JSON.stringify(returned)}`,
  );

  const seenOutside = onDiskBefore.find((line) => line.includes("Node not found") && line.includes("Missing"));
  record(
    "the_editor_reads_what_another_process_reads",
    seenOutside !== undefined && notFound !== undefined && notFound.trimEnd() === seenOutside.trimEnd(),
    seenOutside === undefined
      ? "the runner saw no such line on disk, so the comparison proves nothing"
      : "the line the runner read off disk before the tool call is the line the tool returned",
  );

  record(
    "the_editor_does_not_read_the_game_log",
    !returned.some((line) => line.includes(SENTINEL)),
    `the sentinel planted in ${gameLog} is absent from the editor's answer`,
  );

  const again = await callJson(client, "gd_editor_get_errors", {});
  record(
    "the_error_cursor_advances",
    (again.errors ?? []).length === 0,
    `an immediate second call returned ${JSON.stringify(again.errors)}`,
  );

  // The log cursor never moved while the error cursor was consuming, so the
  // same line is still waiting on the other stream.
  const logs = await callJson(client, "gd_editor_get_logs", {});
  const logText: string = logs.logs ?? "";
  record(
    "logs_and_errors_have_independent_cursors",
    logText.includes("Node not found") && !logText.includes(SENTINEL),
    `gd_editor_get_logs still returned the line the error tool consumed (${logText.length} bytes)`,
  );

  const logsAgain = await callJson(client, "gd_editor_get_logs", {});
  record(
    "the_log_cursor_advances",
    (logsAgain.logs ?? "") === "",
    `an immediate second call returned ${JSON.stringify(logsAgain.logs)}`,
  );

  const bounded = await callJson(client, "gd_scene_node_call", { target: ".", method: "get_child", args: [99] });
  const clipped = await callJson(client, "gd_editor_get_errors", { max_bytes: 64 });
  record(
    "max_bytes_clips_and_says_so",
    clipped.truncated === true,
    `get_child(99) printed, and a 64-byte read reported truncated=${clipped.truncated} (call itself returned ${JSON.stringify(bounded.result)})`,
  );
}

async function unloggedEditorChecks(client: Client, gameLog: string): Promise<void> {
  const result = await call(client, "gd_editor_get_errors", {});
  const text = textOf(result);
  record(
    "an_editor_without_a_log_file_says_so",
    result.isError === true && text.includes("log_unavailable"),
    `gd_editor_get_errors returned: ${text.slice(0, 140)}`,
  );
  record(
    "the_unlogged_editor_does_not_fall_back_to_the_game_log",
    !text.includes(SENTINEL),
    `the sentinel in ${gameLog} did not surface as an editor error`,
  );
}

/**
 * The shipped path, which none of the above exercises: gd_editor_launch chooses
 * the log path itself (`<runtime-dir>/conduit-editor.log`) and sets both the
 * launch argument and the environment variable from it. A broker-launched
 * editor is the primary consumer of these tools, and the runner setting the
 * variable by hand would prove nothing about that.
 */
async function brokerLaunchedEditorChecks(godot: string): Promise<void> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), "--disable-eval"],
    env: conduitEnv(RUNTIME_DIR_LAUNCH, { CONDUIT_GODOT: godot }),
  });
  const client = new Client({ name: "phase21-acceptance-launch", version: "0.7.3" });
  await client.connect(transport);
  try {
    const launch = await callJson(client, "gd_editor_launch", { headless: true });
    record("broker_launched_an_editor", launch.launched === true, `editor pid ${launch.pid} connected`);

    await callJson(client, "gd_scene_open", { path: "res://main.tscn" });
    await call(client, "gd_editor_get_errors", {});
    await callJson(client, "gd_scene_node_call", { target: ".", method: "get_node", args: ["Missing"] });
    const errors = await callJson(client, "gd_editor_get_errors", {});
    const line = (errors.errors ?? []).find((entry: string) => entry.includes("Node not found"));
    record(
      "a_broker_launched_editor_reads_its_own_log",
      line !== undefined,
      line ? `gd_editor_launch's own log path answered: ${line.slice(0, 80)}...` : `nothing came back: ${JSON.stringify(errors)}`,
    );
  } finally {
    await client.callTool({ name: "gd_editor_quit", arguments: {} }).catch(() => {});
    await client.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  for (const dir of [RUNTIME_DIR, RUNTIME_DIR_NOLOG, RUNTIME_DIR_LAUNCH]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  let gameLog = "(unresolved)";

  console.log("\nLaunching headless editor with a log file ...");
  const editor = spawnEditor(godot, RUNTIME_DIR, EDITOR_LOG);
  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 60_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);
    client = await connectBroker(RUNTIME_DIR);
    await assertEvalIsGone(client);
    await loggedEditorChecks(client);
    gameLog = String(
      (
        await callJson(client, "gd_scene_node_call", {
          target: "singleton:ProjectSettings",
          method: "globalize_path",
          args: ["user://logs/godot.log"],
        })
      ).result ?? "",
    );
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
  }

  console.log("\nLaunching a headless editor with no log file ...");
  const unlogged = spawnEditor(godot, RUNTIME_DIR_NOLOG, null);
  let unloggedClient: Client | null = null;
  try {
    await waitForEditor(RUNTIME_DIR_NOLOG, 60_000);
    unloggedClient = await connectBroker(RUNTIME_DIR_NOLOG);
    await unloggedEditorChecks(unloggedClient, gameLog);
  } finally {
    await unloggedClient?.close().catch(() => {});
    killTree(unlogged);
    await unlogged.exited.catch(() => {});
  }

  console.log("\nLaunching an editor through gd_editor_launch ...");
  try {
    await brokerLaunchedEditorChecks(godot);
  } finally {
    for (const dir of [RUNTIME_DIR, RUNTIME_DIR_NOLOG, RUNTIME_DIR_LAUNCH]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\n=== Phase 21 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 21 checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
