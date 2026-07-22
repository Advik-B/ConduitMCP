#!/usr/bin/env bun
// Phase 9 live acceptance runner (whitepaper section 10). Project-defined
// tools and session lifecycle:
//   A. gd_project_scaffold into an empty directory plus gd_editor_launch
//      produce an editor session that answers gd_ping (broker started with no
//      editor at all, proving tolerant startup), then gd_editor_quit confirms
//      the editor exits.
//   B. A method on a node in the conduit_tools group appears as a typed
//      gd_project_* tool, calling it invokes the method, and
//      notifications/tools/list_changed is emitted when the node leaves and
//      rejoins the group.
//   C. Export presets list correctly against the example project.
//   D. Networking smoke: gd_http_request and gd_websocket against a loopback
//      Bun server (fatal), ENet server and client across two game instances
//      (non-fatal; networking is not part of the phase 9 acceptance
//      criterion and must not gate the phase).
//
// Run with `bun tests/evals/phase9_project_tools.ts` (needs GODOT_BIN).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { conduitEnv, godotCommand, killTree, repoRoot, resolveGodot, runtimeDir } from "./harness.ts";

const RUNTIME_A = runtimeDir("p9a");
const RUNTIME_B = runtimeDir("p9b");

interface Check {
  name: string;
  pass: boolean;
  detail: string;
  fatal: boolean;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail, fatal: true });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

// Non-fatal checks report but never gate the phase (used for the ENet
// cross-instance leg, which is outside the acceptance criterion).
function recordNonFatal(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail, fatal: false });
  console.log(`  [${pass ? "PASS" : "WARN"}] ${name}: ${detail}`);
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

async function connectBroker(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env,
  });
  const client = new Client({ name: "phase9-acceptance", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

async function listToolNames(client: Client): Promise<string[]> {
  const result = await client.listTools();
  return result.tools.map((t) => t.name);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function partA(godot: string): Promise<void> {
  console.log("\n=== Part A: scaffold from empty directory, launch, ping, quit ===");
  const projectDir = mkdtempSync(join(os.tmpdir(), "conduit-p9-scaffold-"));
  rmSync(RUNTIME_A, { recursive: true, force: true });
  mkdirSync(RUNTIME_A, { recursive: true });

  // No editor is running: the broker must start anyway (tolerant startup).
  const env = {
    ...process.env,
    CONDUIT_PROJECT: projectDir,
    CONDUIT_RUNTIME_DIR: RUNTIME_A,
    CONDUIT_GODOT: godot,
  } as Record<string, string>;

  let client: Client | null = null;
  try {
    client = await connectBroker(env);
    const status = await callJson(client, "gd_status");
    record("broker_starts_without_editor", status.editor?.connected === false, "broker up with no editor connected");

    const scaffold = await callJson(client, "gd_project_scaffold", { project_name: "Phase 9 Scaffold" });
    const files: string[] = scaffold.files ?? [];
    record(
      "scaffold_writes_project",
      files.some((f) => f.endsWith("project.godot")) && files.some((f) => f.includes("conduit_runtime.tscn")),
      `scaffolded ${files.length} files into ${scaffold.path}`,
    );

    const twice = (await client.callTool({
      name: "gd_project_scaffold",
      arguments: {},
    })) as ToolResult;
    record(
      "scaffold_refuses_overwrite",
      twice.isError === true && (twice.content[0]?.text ?? "").includes("already_exists"),
      "second scaffold without force reports already_exists",
    );

    const launch = await callJson(client, "gd_editor_launch", { headless: true });
    record(
      "editor_launch_connects",
      launch.launched === true && typeof launch.engine_version === "string",
      `editor pid ${launch.pid} connected (engine ${launch.engine_version})`,
    );

    const pong = await callJson(client, "gd_ping");
    record("scaffolded_editor_answers_ping", pong.pong === true, `gd_ping frame ${pong.frame}`);

    const presets = await callJson(client, "gd_export_presets");
    record(
      "scaffolded_project_has_no_presets",
      presets.total_count === 0 && Array.isArray(presets.items),
      "gd_export_presets returns an empty page",
    );

    const quit = await callJson(client, "gd_editor_quit");
    record("editor_quit_confirmed", quit.quit === true && quit.forced === false, `quit confirmed (forced: ${quit.forced})`);
  } finally {
    if (client) {
      await client.callTool({ name: "gd_editor_quit", arguments: {} }).catch(() => {});
      await client.close().catch(() => {});
    }
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(RUNTIME_A, { recursive: true, force: true });
  }
}

async function partBCD(godot: string): Promise<void> {
  console.log("\n=== Part B: conduit_tools methods as dynamic typed tools with listChanged ===");
  rmSync(RUNTIME_B, { recursive: true, force: true });
  mkdirSync(RUNTIME_B, { recursive: true });

  const env = conduitEnv(RUNTIME_B, { CONDUIT_GODOT: godot });
  let client: Client | null = null;
  let game: ReturnType<typeof Bun.spawn> | null = null;
  let game2: ReturnType<typeof Bun.spawn> | null = null;
  const servers: Array<{ stop: () => void }> = [];
  try {
    client = await connectBroker(env);
    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount += 1;
    });

    const before = await listToolNames(client);
    record(
      "no_project_tools_before_game",
      !before.some((n) => n.startsWith("gd_project_") && !["gd_project_scaffold", "gd_project_get_setting", "gd_project_set_setting"].includes(n)),
      "static surface has no dynamic gd_project_* tools",
    );

    console.log("Launching bare headless game into phase9.tscn ...");
    game = Bun.spawn(godotCommand(godot, ["--headless", "--path", "example-project", "res://phase9.tscn"], false), {
      cwd: repoRoot,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });

    // Background discovery adopts the game, pulls gd_project_tools_list, and
    // registers the dynamic tools; each registration emits listChanged.
    const appeared = await waitFor(async () => (await listToolNames(client!)).includes("gd_project_spawn_marker"), 90_000);
    record("project_tool_appears", appeared, "gd_project_spawn_marker registered after game adoption");
    record("list_changed_on_registration", listChangedCount > 0, `${listChangedCount} listChanged notifications so far`);

    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    record(
      "exposure_rules_hold",
      names.includes("gd_project_get_speed") &&
        names.includes("gd_project_echo_variant") &&
        names.includes("gd_project_only_this") &&
        !names.includes("gd_project__internal") &&
        !names.includes("gd_project_hidden_method"),
      "underscore methods and undeclared subset methods never surface",
    );

    const spawnTool = tools.find((t) => t.name === "gd_project_spawn_marker");
    const schema = (spawnTool?.inputSchema ?? {}) as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    record(
      "project_tool_is_typed",
      schema.properties?.marker_name?.type === "string" &&
        schema.properties?.count?.type === "integer" &&
        (schema.required ?? []).includes("marker_name") &&
        !(schema.required ?? []).includes("count"),
      `schema: ${JSON.stringify(schema.properties ?? {})} required=${JSON.stringify(schema.required ?? [])}`,
    );

    const call1 = await callJson(client, "gd_project_spawn_marker", { marker_name: "alpha", count: 3 });
    record("project_tool_invokes_method", call1.result === 3, `spawn_marker('alpha', 3) returned ${call1.result}`);

    const call2 = await callJson(client, "gd_project_spawn_marker", { marker_name: "beta" });
    record("project_tool_applies_defaults", call2.result === 4, `spawn_marker('beta') with default count returned ${call2.result}`);

    const echoed = await callJson(client, "gd_project_echo_variant", { v: { __type: "Vector2", x: 3, y: 4 } });
    record(
      "project_tool_round_trips_tagged_types",
      echoed.result?.__type === "Vector2" && echoed.result?.x === 3,
      `echo_variant returned ${JSON.stringify(echoed.result)}`,
    );

    // Leave: the tool disappears and listChanged fires again.
    const beforeLeave = listChangedCount;
    await callJson(client, "gd_game_eval", {
      source: 'get_node("/root/Phase9/Tools").remove_from_group("conduit_tools")\nreturn true',
    });
    const disappeared = await waitFor(async () => !(await listToolNames(client!)).includes("gd_project_spawn_marker"), 30_000);
    record("tool_removed_on_group_leave", disappeared, "gd_project_spawn_marker gone after remove_from_group");
    record("list_changed_on_leave", listChangedCount > beforeLeave, `listChanged count ${beforeLeave} -> ${listChangedCount}`);

    // Join: it comes back with another listChanged.
    const beforeJoin = listChangedCount;
    await callJson(client, "gd_game_eval", {
      source: 'get_node("/root/Phase9/Tools").add_to_group("conduit_tools")\nreturn true',
    });
    const reappeared = await waitFor(async () => (await listToolNames(client!)).includes("gd_project_spawn_marker"), 30_000);
    record("tool_returns_on_group_join", reappeared, "gd_project_spawn_marker back after add_to_group");
    record("list_changed_on_join", listChangedCount > beforeJoin, `listChanged count ${beforeJoin} -> ${listChangedCount}`);

    await partC(client);
    await partD(client, godot, env, (proc) => {
      game2 = proc;
    }, servers);

    // Game exit clears the dynamic surface.
    const beforeExit = listChangedCount;
    if (game2) {
      killTree(game2);
      game2 = null;
    }
    killTree(game);
    await game.exited.catch(() => {});
    game = null;
    const cleared = await waitFor(async () => !(await listToolNames(client!)).includes("gd_project_spawn_marker"), 30_000);
    record("tools_cleared_on_game_exit", cleared, `dynamic tools removed after game exit (listChanged ${beforeExit} -> ${listChangedCount})`);
  } finally {
    if (client) {
      await client.callTool({ name: "gd_editor_quit", arguments: {} }).catch(() => {});
      await client.close().catch(() => {});
    }
    if (game2) {
      killTree(game2);
    }
    if (game) {
      killTree(game);
    }
    for (const server of servers) {
      server.stop();
    }
    rmSync(RUNTIME_B, { recursive: true, force: true });
  }
}

async function partC(client: Client): Promise<void> {
  console.log("\n=== Part C: export presets list correctly ===");
  // The broker has no editor yet in this session; gd_editor_launch brings one
  // up on the example project.
  const launch = await callJson(client, "gd_editor_launch", { headless: true });
  record("example_editor_launches", launch.launched === true, `editor pid ${launch.pid} (engine ${launch.engine_version})`);

  const presets = await callJson(client, "gd_export_presets");
  const items: Array<{ name: string; platform: string; exclude_filter?: string }> = presets.items ?? [];
  const names = items.map((p) => p.name).sort();
  const expected = [
    "Linux (debug)",
    "Linux (release)",
    "Windows Desktop (debug)",
    "Windows Desktop (release)",
    "macOS (debug)",
    "macOS (release)",
  ];
  record(
    "export_presets_list",
    presets.total_count === 6 && JSON.stringify(names) === JSON.stringify(expected.sort()),
    `6 presets: ${names.join(", ")}`,
  );

  const releases = items.filter((p) => p.name.includes("(release)"));
  record(
    "release_presets_exclude_bridge",
    releases.length === 3 && releases.every((p) => (p.exclude_filter ?? "").includes("addons/conduit")),
    "every release preset carries the bridge exclude_filter",
  );

  const paged = await callJson(client, "gd_export_presets", { limit: 2, offset: 4 });
  record(
    "export_presets_paginate",
    paged.items?.length === 2 && paged.has_more === false && paged.total_count === 6,
    `limit=2 offset=4 -> ${paged.items?.length} items, has_more ${paged.has_more}`,
  );

  const quit = await callJson(client, "gd_editor_quit");
  record("example_editor_quits", quit.quit === true, `quit confirmed (forced: ${quit.forced})`);
}

async function partD(
  client: Client,
  godot: string,
  env: Record<string, string>,
  adoptSecondGame: (proc: ReturnType<typeof Bun.spawn>) => void,
  servers: Array<{ stop: () => void }>,
): Promise<void> {
  console.log("\n=== Part D: networking (HTTP and WebSocket fatal; ENet non-fatal) ===");

  const http = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method === "POST") {
        return new Response(`echo:${request.headers.get("x-conduit") ?? ""}`, { status: 201 });
      }
      return new Response("hello from bun", { status: 200 });
    },
  });
  servers.push({ stop: () => http.stop(true) });

  const get = await callJson(client, "gd_http_request", { url: `http://127.0.0.1:${http.port}/` });
  record(
    "http_get",
    get.response_code === 200 && get.body === "hello from bun" && get.truncated === false,
    `GET -> ${get.response_code} '${get.body}'`,
  );

  const post = await callJson(client, "gd_http_request", {
    url: `http://127.0.0.1:${http.port}/submit`,
    method: "POST",
    headers: { "x-conduit": "p9" },
    body: "payload",
  });
  record("http_post_headers", post.response_code === 201 && post.body === "echo:p9", `POST -> ${post.response_code} '${post.body}'`);

  const refused = (await client.callTool({
    name: "gd_http_request",
    arguments: { url: "http://127.0.0.1:9", timeout_s: 5 },
  })) as ToolResult;
  record(
    "http_failure_is_network_error",
    refused.isError === true && (refused.content[0]?.text ?? "").includes("network_error"),
    "refused connection reports network_error",
  );

  const ws = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) {
        return;
      }
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        socket.send(`pong:${message}`);
      },
    },
  });
  servers.push({ stop: () => ws.stop(true) });

  const connected = await callJson(client, "gd_websocket", { op: "connect", url: `ws://127.0.0.1:${ws.port}/` });
  record("ws_connect", connected.state === "open" && typeof connected.id === "number", `connection ${connected.id} open`);

  await callJson(client, "gd_websocket", { op: "send", id: connected.id, text: "marco" });
  const received = await callJson(client, "gd_websocket", { op: "recv", id: connected.id, timeout_s: 15 });
  record(
    "ws_echo_round_trip",
    received.timed_out === false && received.message?.text === "pong:marco",
    `received ${JSON.stringify(received.message)}`,
  );

  const closed = await callJson(client, "gd_websocket", { op: "close", id: connected.id });
  record("ws_close", closed.closed === true, `connection ${connected.id} closed`);

  // ENet across two game instances: non-fatal (outside the acceptance
  // criterion); a flaky handshake must not gate the phase.
  try {
    console.log("Launching second bare game for the ENet leg ...");
    const game2 = Bun.spawn(godotCommand(godot, ["--headless", "--path", "example-project", "res://phase9.tscn"], false), {
      cwd: repoRoot,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    adoptSecondGame(game2);

    const adopted = await waitFor(async () => {
      const games = await callJson(client, "gd_game_list");
      return (games.games?.length ?? 0) >= 2;
    }, 90_000);
    recordNonFatal("enet_second_instance_adopted", adopted, "two game instances connected");
    if (!adopted) {
      return;
    }

    const games = await callJson(client, "gd_game_list");
    const pids: number[] = games.games.map((g: { pid: number }) => g.pid);
    const serverPid = pids[0]!;
    const clientPid = pids[1]!;

    const created = await callJson(client, "gd_multiplayer", { op: "create_server", port: 39_099, instance: serverPid });
    recordNonFatal("enet_server_created", created.unique_id === 1, `server up on 39099 (unique_id ${created.unique_id})`);

    await callJson(client, "gd_multiplayer", {
      op: "create_client",
      address: "127.0.0.1",
      port: 39_099,
      instance: clientPid,
    });
    const joined = await waitFor(async () => {
      const status = await callJson(client, "gd_multiplayer", { op: "status", instance: serverPid });
      return (status.peers?.length ?? 0) >= 1;
    }, 30_000);
    const serverStatus = await callJson(client, "gd_multiplayer", { op: "status", instance: serverPid });
    recordNonFatal("enet_client_joined", joined, `server peers: ${JSON.stringify(serverStatus.peers)}`);

    await callJson(client, "gd_multiplayer", { op: "disconnect", instance: clientPid });
    await callJson(client, "gd_multiplayer", { op: "disconnect", instance: serverPid });
    recordNonFatal("enet_disconnect", true, "both peers disconnected");
  } catch (error) {
    recordNonFatal("enet_leg", false, `ENet leg failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  await partA(godot);
  await partBCD(godot);

  console.log("\n=== Phase 9 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : c.fatal ? "FAIL" : "WARN"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass && c.fatal);
  const warned = checks.filter((c) => !c.pass && !c.fatal);
  if (warned.length > 0) {
    console.log(`\n${warned.length} non-fatal check(s) did not pass (recorded, not gating).`);
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll fatal checks passed.");
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
