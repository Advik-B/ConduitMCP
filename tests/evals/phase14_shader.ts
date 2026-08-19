#!/usr/bin/env bun
// Live acceptance for phase 14, shader diagnostics: compiling a .gdshader
// through the engine and reporting line-numbered errors (whitepaper section 8,
// "Shader creation gets the same log-derived compile diagnostics").
//
// The load-bearing detail, as in every runner since phase 10, is that the
// broker runs with --disable-eval. A shader's source is reachable from GDScript,
// so a runner with gd_editor_eval registered would pass whether or not
// gd_shader_validate existed.
//
// Headless editor, deliberately. The phase-14 probe established that Godot
// 4.7.1's dummy renderer compiles Godot-language shaders and prints
// SHADER ERROR with a line number (docs/api-gaps.md), so this needs no display
// and belongs in ci:phases rather than in the phase 2/5/6 rendering tier.
//
// Run with `bun tests/evals/phase14_shader.ts` (needs GODOT_BIN).

import { existsSync, mkdirSync, rmSync } from "node:fs";
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

const RUNTIME_DIR = runtimeDir("p14");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");
const SHADER_RES = "res://conduit_phase14.gdshader";
const SHADER_FILE = join(exampleProject, "conduit_phase14.gdshader");
const INCLUDE_RES = "res://conduit_phase14.gdshaderinc";

// The error sits on line 4 so the runner can assert the reported line rather
// than merely asserting that something was reported. A tool that returned
// `valid: false` with no usable location would pass a weaker check.
const BROKEN_SHADER = `shader_type canvas_item;

void fragment() {
	COLOR = vec4(1.0, 0.0, 0.0 1.0);
}
`;

const FIXED_SHADER = `shader_type canvas_item;

void fragment() {
	COLOR = vec4(1.0, 0.0, 0.0, 1.0);
}
`;

const NO_TYPE_SHADER = `void fragment() {
	COLOR = vec4(1.0);
}
`;

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

async function writeShader(client: Client, path: string, source: string): Promise<void> {
  await callJson(client, "gd_asset_add", {
    path,
    data_base64: Buffer.from(source, "utf8").toString("base64"),
  });
}

async function main(): Promise<void> {
  const godot = resolveGodot();
  console.log(`Godot: ${godot}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);

  console.log("\nBuilding bridge (cargo build -p conduit) ...");
  if ((await run(["cargo", "build", "-p", "conduit"], repoRoot)) !== 0) {
    throw new Error("bridge build failed");
  }

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  cleanupShader();

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
    await brokenShaderChecks(client);
    await fixedShaderChecks(client);
    await shaderTypeChecks(client);
    await errorChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    cleanupShader();
  }

  console.log("\n=== Phase 14 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 14 checks passed.");
}

function cleanupShader(): void {
  for (const file of [SHADER_FILE, `${SHADER_FILE}.uid`, join(exampleProject, "conduit_phase14.gdshaderinc")]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }
}

/**
 * The premise of the whole runner. If gd_editor_eval is registered, every check
 * below could be passing for the wrong reason.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
  record(
    "shader_validate_registered",
    names.includes("gd_shader_validate"),
    names.includes("gd_shader_validate") ? "gd_shader_validate is on the default surface" : "gd_shader_validate is missing",
  );
}

async function brokenShaderChecks(client: Client): Promise<void> {
  console.log("\nValidating a shader with a deliberate syntax error ...");
  await writeShader(client, SHADER_RES, BROKEN_SHADER);

  const started = Date.now();
  const result = await callJson(client, "gd_shader_validate", { path: SHADER_RES });
  const elapsed = Date.now() - started;

  record("broken_shader_is_invalid", result.valid === false, `valid=${result.valid} after ${elapsed}ms`);

  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  record(
    "broken_shader_reports_a_diagnostic",
    diagnostics.length > 0,
    diagnostics.length > 0 ? `${diagnostics.length} diagnostic(s): ${JSON.stringify(diagnostics[0])}` : "no diagnostics returned",
  );

  // The whole point of the tool: a location, not just a verdict.
  const line = diagnostics[0]?.line;
  record("diagnostic_names_the_offending_line", line === 4, `reported line ${JSON.stringify(line)}, expected 4`);

  const message = String(diagnostics[0]?.message ?? "");
  record("diagnostic_carries_a_message", message.length > 0, message || "empty message");

  // The compiler echoes the shader's own source around the error. If that echo
  // leaked into the diagnostics, this count would be far higher than one.
  record(
    "the_source_echo_is_not_reported_as_diagnostics",
    diagnostics.length === 1,
    `${diagnostics.length} diagnostic(s); the compiler reports the first error only`,
  );
}

async function fixedShaderChecks(client: Client): Promise<void> {
  console.log("\nFixing the shader and validating again ...");
  await writeShader(client, SHADER_RES, FIXED_SHADER);

  const result = await callJson(client, "gd_shader_validate", { path: SHADER_RES });
  record("fixed_shader_is_valid", result.valid === true, `valid=${result.valid}`);
  record(
    "valid_shader_has_no_diagnostics",
    Array.isArray(result.diagnostics) && result.diagnostics.length === 0,
    `diagnostics=${JSON.stringify(result.diagnostics)}`,
  );
  record("response_echoes_the_path", result.path === SHADER_RES, `path=${result.path}`);
}

async function shaderTypeChecks(client: Client): Promise<void> {
  console.log("\nValidating a shader with no shader_type declaration ...");
  await writeShader(client, SHADER_RES, NO_TYPE_SHADER);

  const result = await callJson(client, "gd_shader_validate", { path: SHADER_RES });
  record("missing_shader_type_is_invalid", result.valid === false, `valid=${result.valid}`);

  const message = String(result.diagnostics?.[0]?.message ?? "");
  record("missing_shader_type_is_explained", message.includes("shader_type"), message || "no message");
  // The dummy renderer words this as its own limitation ("not supported in
  // Dummy renderer"), which would read as a defect in the tool rather than in
  // the shader. The handler restates it; this asserts the restatement.
  record("the_renderers_own_wording_does_not_leak", !message.includes("Dummy"), message || "no message");
}

async function errorChecks(client: Client): Promise<void> {
  console.log("\nChecking rejections ...");

  const missing = await callExpectingError(client, "gd_shader_validate", { path: "res://conduit_phase14_absent.gdshader" });
  record("a_missing_shader_is_an_error", missing.length > 0, missing.slice(0, 160));

  const outside = await callExpectingError(client, "gd_shader_validate", { path: "/etc/passwd" });
  record("a_path_outside_the_project_is_rejected", outside.includes("res://"), outside.slice(0, 160));

  const wrongKind = await callExpectingError(client, "gd_shader_validate", { path: "res://conduit_phase14.gd" });
  record("a_non_shader_extension_is_rejected", wrongKind.includes(".gdshader"), wrongKind.slice(0, 160));

  // An include fragment has no shader_type of its own, so compiling one would
  // report a missing declaration that is not a defect in the fragment.
  const include = await callExpectingError(client, "gd_shader_validate", { path: INCLUDE_RES });
  record("an_include_fragment_is_rejected", include.includes(".gdshader"), include.slice(0, 160));
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase14-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
