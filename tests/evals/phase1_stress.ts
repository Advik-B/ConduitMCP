#!/usr/bin/env bun
// Phase 1 live acceptance runner (whitepaper section 10). Builds the bridge,
// runs the engine-free stress + release-gate tests, then launches a real
// headless Godot editor and proves, over the actual socket:
//
//   - the bridge loads and binds its listener;
//   - a flood produces `busy` backpressure, not unbounded growth;
//   - accepted pings round-trip with correct id correlation while the editor
//     keeps stepping frames (stays responsive);
//   - gd_wait_frames completes via deferred resolution exactly N frames later;
//   - gd_ping round-trips through the broker via a real MCP client.
//
// Run with `bun tests/evals/phase1_stress.ts`.

import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type Endpoint, endpointKey } from "../../broker/src/endpoint.ts";
import { BridgeClient } from "../../broker/src/ipc-client.ts";
import { conduitEnv, godotCommand, killTree, repoRoot, resolveGodot, runtimeDir, waitForEditor } from "./harness.ts";
import { floodPing, summarize, waitFrames } from "./phase1_stress_client.ts";

const RUNTIME_DIR = runtimeDir("p1");
const FLOOD_COUNT = 8000;
const WAIT_FRAMES = 60;

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
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  console.log("\nRunning engine-free stress and release-gate tests ...");
  const cargoTests = await run(
    ["cargo", "test", "-p", "conduit", "--", "--include-ignored"],
    repoRoot,
  );
  record("engine_free_tests", cargoTests === 0, cargoTests === 0 ? "cargo test passed" : "cargo test failed");

  console.log("\nLaunching headless editor ...");
  // Hash-based discovery: the bridge and broker derive the same endpoint from the
  // project path, with no CONDUIT_SOCK pinning it (exercises the real default).
  const editor = Bun.spawn(godotCommand(godot, ["--headless", "--editor", "--path", "example-project"], false), {
    cwd: repoRoot,
    env: conduitEnv(RUNTIME_DIR),
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 45_000);
    record("bridge_bound", true, `listener bound at ${endpointKey(endpoint)}`);

    await runLiveChecks(endpoint);
    await runMcpRoundTrip();
  } finally {
    killTree(editor);
    await editor.exited.catch(() => {});
  }

  console.log("\n=== Phase 1 acceptance summary ===");
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 1 checks passed.");
}

async function runLiveChecks(endpoint: Endpoint): Promise<void> {
  const client = new BridgeClient({ endpoint });
  await client.connect();
  try {
    console.log(`\nFlooding ${FLOOD_COUNT} pings over the raw socket ...`);
    const flood = await floodPing(client, FLOOD_COUNT);
    const accounted = flood.accepted + flood.busy + flood.otherErrors === flood.sent;
    const distinctFrames = new Set(flood.frames).size;
    const delta = summarize(flood.deltasMs);

    record("flood_busy", flood.busy > 0, `${flood.busy} of ${flood.sent} rejected as busy (backpressure)`);
    record(
      "flood_accepted_correlated",
      flood.accepted > 0 && flood.otherErrors === 0,
      `${flood.accepted} accepted and correlated, ${flood.otherErrors} unexpected errors`,
    );
    record("flood_accounting", accounted, `accepted+busy+other == sent (${flood.sent})`);
    record(
      "editor_responsive",
      distinctFrames > 1,
      `accepted pings spanned ${distinctFrames} distinct frames; inter-frame delta ms min/median/max = ${delta.min.toFixed(2)}/${delta.median.toFixed(2)}/${delta.max.toFixed(2)}`,
    );

    console.log(`\nSubmitting gd_wait_frames(${WAIT_FRAMES}) for deferred completion ...`);
    const wait = await waitFrames(client, WAIT_FRAMES);
    const span = wait.completed_frame - wait.submitted_frame;
    record("deferred_completion", span === WAIT_FRAMES, `wait spanned exactly ${span} frames (expected ${WAIT_FRAMES})`);
  } finally {
    client.close();
    // Let the bridge notice the disconnect and return to accepting before the
    // broker connects (the phase 1 listener serves one client at a time).
    await sleep(500);
  }
}

async function runMcpRoundTrip(): Promise<void> {
  console.log("\nRound-tripping gd_ping through the broker via a real MCP client ...");
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts")],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase1-acceptance", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    record("mcp_tools_listed", names.includes("gd_ping") && names.includes("gd_wait_frames"), `tools: ${names.join(", ")}`);

    const first = await callPing(client);
    const second = await callPing(client);
    const ok = first.pong === true && second.pong === true && typeof first.frame === "number";
    record(
      "mcp_round_trip",
      ok,
      `two gd_ping calls returned pong with frames ${first.frame} then ${second.frame} (broker id correlation intact)`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

async function callPing(client: Client): Promise<{ pong: boolean; frame: number }> {
  const result = (await client.callTool({ name: "gd_ping", arguments: {} })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (result.isError) {
    throw new Error(`gd_ping returned an error: ${result.content[0]?.text}`);
  }
  const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text) as { pong: boolean; frame: number };
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
