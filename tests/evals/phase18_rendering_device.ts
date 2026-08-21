#!/usr/bin/env bun
// Phase 18 live acceptance runner: what the compute-shader regrade rests on.
//
// Phase 18 was a measurement phase and shipped no tool. It moved exactly one
// tutorial heading out of T2 -- "Create a local RenderingDevice" -- and the
// first half of this runner is the check behind that move.
//
// The second half used to be the other side of that grading: everything built
// on the device exchanges RIDs, which had no JSON form, so the rest of the page
// stayed T2. Phase 19 gave an RID a tagged form in both directions, so the same
// two calls now run as a round trip rather than as a boundary, and the buffer
// headings move with them. What this runner asserts changed; which claim it
// carries did not.
//
// Needs a display and a RenderingDevice-based renderer. Measured, not assumed:
// --headless forces the dummy rendering driver and
// create_local_rendering_device() answers null under it, whatever
// --rendering-method says, and the example project ships gl_compatibility,
// which has no RenderingDevice either. That is why this runner passes
// --rendering-method forward_plus explicitly and why it is not in ci:phases,
// the same reason phase 6 is not (docs/api-gaps.md).
//
// Run with `bun tests/evals/phase18_rendering_device.ts` (needs GODOT_BIN).

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  conduitEnv,
  endpointKey,
  godotCommand,
  killTree,
  repoRoot,
  requireDisplay,
  resolveGodot,
  runtimeDir,
  waitForEditor,
} from "./harness.ts";

const RUNTIME_DIR = runtimeDir("p18");
const HEADLESS_RUNTIME_DIR = runtimeDir("p18headless");

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

async function connectBroker(rtDir: string, extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(rtDir),
  });
  const client = new Client({ name: "phase18-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

/**
 * The premise. With gd_editor_eval registered, every check below could pass
 * whether or not the target grammar or object handles existed.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
}

/**
 * The tier claim: the device arrives as the return value of a singleton call,
 * capture names it, and the name still resolves on a later call.
 *
 * get_device_name is the load-bearing half. A handle that only ever appears in
 * the response that minted it would prove nothing; answering with the adapter
 * proves the second call reached the same live RenderingDevice.
 */
async function deviceCaptureChecks(client: Client): Promise<string | null> {
  console.log("\nLocal rendering device ...");

  const created = await callJson(client, "gd_scene_node_call", {
    target: "singleton:RenderingServer",
    method: "create_local_rendering_device",
    capture: true,
  });
  const handle = typeof created.handle === "string" ? created.handle : null;
  record(
    "device_captured_as_a_handle",
    handle !== null && handle.startsWith("object:") && created.handle_class === "RenderingDevice",
    handle === null
      ? `no handle in ${JSON.stringify(created)}`
      : `create_local_rendering_device -> ${created.handle_class} as ${handle}`,
  );
  if (handle === null) {
    return null;
  }

  const named = await callJson(client, "gd_scene_node_call", { target: handle, method: "get_device_name" });
  record(
    "handle_survives_to_a_second_call",
    typeof named.result === "string" && named.result.length > 0,
    `${handle}.get_device_name() -> ${JSON.stringify(named.result)}`,
  );

  return handle;
}

/**
 * The buffer headings, which phase 19 earned. storage_buffer_create hands back
 * an RID and buffer_get_data wants one, so this pair is the smallest complete
 * statement of the exchange the whole compute workflow is built on.
 *
 * The readback is what makes it a round trip rather than two calls that each
 * happened to succeed: a freshly created 16-byte storage buffer reads back as
 * 16 zero bytes, so the RID that came out of the first call is proven to name
 * the buffer the second call read.
 *
 * The steps beyond this pair -- shader_create_from_spirv, uniform_set_create,
 * compute_pipeline_create, and the compute list -- are not exercised here, and
 * are graded on what this runner reaches rather than on what the mechanism
 * suggests.
 */
async function ridRoundTripChecks(client: Client, handle: string): Promise<void> {
  console.log("\nThe RID round trip ...");

  const buffer = await callJson(client, "gd_scene_node_call", {
    target: handle,
    method: "storage_buffer_create",
    args: [16],
  });
  const rid = buffer.result as { __type?: string; id?: unknown };
  record(
    "a_returned_rid_is_tagged",
    rid?.__type === "RID" && typeof rid.id === "string" && /^\d+$/.test(rid.id),
    `storage_buffer_create(16) -> ${JSON.stringify(rid)}`,
  );
  if (rid?.__type !== "RID") {
    return;
  }

  const read = await callJson(client, "gd_scene_node_call", {
    target: handle,
    method: "buffer_get_data",
    args: [rid],
  });
  const bytes = Array.isArray(read.result) ? (read.result as number[]) : null;
  record(
    "a_returned_rid_can_be_spent",
    bytes !== null && bytes.length === 16 && bytes.every((b) => b === 0),
    bytes === null
      ? `buffer_get_data returned ${JSON.stringify(read.result)}`
      : `buffer_get_data(rid) -> ${bytes.length} bytes, all zero: ${bytes.every((b) => b === 0)}`,
  );

  await callJson(client, "gd_scene_node_call", { target: handle, method: "free_rid", args: [rid] });
  record("a_spent_rid_can_be_freed", true, `free_rid(${rid.id}) returned`);
}

/**
 * The condition the grading states. The via on t1:local_rendering_device says
 * the engine answers null unless the renderer is RenderingDevice-based, so the
 * runner shows the null rather than leaving the reader to trust the sentence.
 */
async function headlessIsDummyChecks(godot: string): Promise<void> {
  console.log("\nHeadless, for contrast ...");
  rmSync(HEADLESS_RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(HEADLESS_RUNTIME_DIR, { recursive: true });

  const editor = Bun.spawn(
    godotCommand(
      godot,
      ["--headless", "--editor", "--path", "example-project", "--rendering-method", "forward_plus"],
      false,
    ),
    { cwd: repoRoot, env: conduitEnv(HEADLESS_RUNTIME_DIR), stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    await waitForEditor(HEADLESS_RUNTIME_DIR, 90_000);
    client = await connectBroker(HEADLESS_RUNTIME_DIR, ["--disable-eval"]);
    const created = await callJson(client, "gd_scene_node_call", {
      target: "singleton:RenderingServer",
      method: "create_local_rendering_device",
      capture: true,
    });
    record(
      "headless_has_no_rendering_device",
      created.captured === false && created.result === null,
      `--headless --rendering-method forward_plus still answers ${JSON.stringify(created.result)}`,
    );
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(HEADLESS_RUNTIME_DIR, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  requireDisplay();
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  console.log("\nLaunching editor on forward_plus ...");
  const editor = Bun.spawn(
    godotCommand(
      godot,
      ["--editor", "--path", "example-project", "--rendering-method", "forward_plus"],
      true,
    ),
    { cwd: repoRoot, env: conduitEnv(RUNTIME_DIR), stdout: "ignore", stderr: "ignore" },
  );

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 90_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker(RUNTIME_DIR, ["--disable-eval"]);
    await assertEvalIsGone(client);
    const handle = await deviceCaptureChecks(client);
    if (handle !== null) {
      await ridRoundTripChecks(client, handle);
    }
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  await headlessIsDummyChecks(godot);

  console.log("\n=== Phase 18 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 18 checks passed.");
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
