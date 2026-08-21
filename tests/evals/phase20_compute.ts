#!/usr/bin/env bun
// Phase 20 live acceptance runner: the compute workflow, end to end.
//
// The question this answers is the one phase 19's `### Next` left open.
// uniform_set_create's first parameter is a typed Array[RDUniform] and an
// `args` list builds an untyped Array, so whether the engine accepts one for
// the other was undemonstrated. Three documents asserted that gap and none of
// them rested on a measurement, which is the shape phases 14, 18 and 19 each
// found rotting.
//
// A returned RID proves nothing on its own. The declared parameter type is
// ARRAY, so a strict-convertibility check passes before any element type is
// looked at, and a refusal can be soft: an engine error printed, an empty array
// left behind, and a plausible RID handed back. The acceptance is therefore the
// computed readback -- four floats that come back doubled -- which is phase
// 18's "16 zero bytes proves the RID names the buffer" applied to a chain
// instead of a pair. The editor's own output is captured so that a soft refusal
// can be quoted rather than lost.
//
// Needs a display and a RenderingDevice-based renderer, so it is not in
// ci:phases, for the reason phase 6 and phase 18 are not: --headless forces the
// dummy rendering driver and create_local_rendering_device() answers null under
// it (docs/api-gaps.md). Phase 18 carries that contrast check; this runner does
// not repeat it.
//
// Run with `bun tests/evals/phase20_compute.ts` (needs GODOT_BIN).

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

const RUNTIME_DIR = runtimeDir("p20");

// Three counts that have to agree: four floats in the buffer, four threads per
// work group, one group dispatched. If one of them drifts, the dispatch covers
// part of the buffer and the readback comes back half doubled, which is why the
// final check compares every element rather than running a predicate.
const INPUT = [1, 2, 3, 4];
const LOCAL_SIZE_X = 4;
const GROUPS_X = 1;

const COMPUTE_GLSL = `#version 450

layout(local_size_x = ${LOCAL_SIZE_X}, local_size_y = 1, local_size_z = 1) in;

layout(set = 0, binding = 0, std430) restrict buffer MyDataBuffer {
    float data[];
}
my_data_buffer;

void main() {
    my_data_buffer.data[gl_GlobalInvocationID.x] *= 2.0;
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
  const client = new Client({ name: "phase20-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

/**
 * The editor's own output, kept so that a soft refusal can be quoted.
 *
 * An element-type rejection inside the engine prints and returns rather than
 * throwing, so it would reach the client as a successful call with a useless
 * result. Draining both streams also keeps a full pipe from parking the editor,
 * which is why phase 18 could get away with ignoring them and this cannot.
 */
const engineOutput: string[] = [];
function drain(stream: ReadableStream<Uint8Array> | null | undefined): void {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
      if (chunk.done) {
        return;
      }
      engineOutput.push(decoder.decode(chunk.value, { stream: true }));
    }
  })();
}

function outputMark(): number {
  return engineOutput.join("").length;
}

async function outputSince(mark: number): Promise<string> {
  // The engine's print is not synchronised with the tool response, so give the
  // pipe a moment before reading back what the call produced.
  await Bun.sleep(300);
  return engineOutput.join("").slice(mark).trim();
}

function floatsToBytes(values: number[]): number[] {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(new Uint8Array(view.buffer));
}

function bytesToFloats(bytes: number[]): number[] {
  const view = new DataView(new Uint8Array(bytes).buffer);
  const values: number[] = [];
  for (let index = 0; index * 4 < bytes.length; index += 1) {
    values.push(view.getFloat32(index * 4, true));
  }
  return values;
}

/**
 * The premise. With gd_editor_eval registered, every check below could pass
 * whether or not the argument grammar carried any of this.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
}

/**
 * Enum values come from the live ClassDB, not from this file.
 *
 * Writing the integers here would make the runner assert its own memory of the
 * engine rather than the engine, which is the discipline phase 19's STATIC
 * precheck rests on.
 */
async function constantValue(client: Client, className: string, name: string): Promise<number> {
  let offset = 0;
  for (;;) {
    const page = await callJson(client, "gd_classdb", { op: "constants", class: className, limit: 500, offset });
    for (const item of page.items as { name: string; value: number }[]) {
      if (item.name === name) {
        return item.value;
      }
    }
    if (page.next_offset === null || page.next_offset === undefined) {
      throw new Error(`${className} has no constant '${name}'`);
    }
    offset = page.next_offset as number;
  }
}

interface Rid {
  __type?: string;
  id?: string;
}

function isRid(value: unknown): value is Rid {
  const rid = value as Rid | null;
  return rid?.__type === "RID" && typeof rid.id === "string" && /^\d+$/.test(rid.id);
}

function objectArg(handle: string): Record<string, unknown> {
  return { __type: "Object", handle };
}

async function computeChecks(client: Client): Promise<void> {
  console.log("\nThe compute chain ...");

  const glsl = await constantValue(client, "RenderingDevice", "SHADER_LANGUAGE_GLSL");
  const computeStage = await constantValue(client, "RenderingDevice", "SHADER_STAGE_COMPUTE");
  const storageBuffer = await constantValue(client, "RenderingDevice", "UNIFORM_TYPE_STORAGE_BUFFER");
  record(
    "constants_read_from_classdb",
    true,
    `GLSL=${glsl}, STAGE_COMPUTE=${computeStage}, UNIFORM_TYPE_STORAGE_BUFFER=${storageBuffer}`,
  );

  const created = await callJson(client, "gd_scene_node_call", {
    target: "singleton:RenderingServer",
    method: "create_local_rendering_device",
    capture: true,
  });
  const device = typeof created.handle === "string" ? (created.handle as string) : null;
  record(
    "device_captured",
    device !== null && created.handle_class === "RenderingDevice",
    device === null ? `no handle in ${JSON.stringify(created)}` : `${created.handle_class} as ${device}`,
  );
  if (device === null) {
    return;
  }

  const source = await callJson(client, "gd_scene_object", {
    op: "create",
    class: "RDShaderSource",
    properties: { source_compute: COMPUTE_GLSL, language: glsl },
  });
  record(
    "shader_source_constructed",
    typeof source.handle === "string" && (source.properties_set as string[]).length === 2,
    `RDShaderSource as ${source.handle}, set ${JSON.stringify(source.properties_set)}`,
  );

  const compiled = await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "shader_compile_spirv_from_source",
    args: [objectArg(source.handle as string)],
    capture: true,
  });
  const spirv = typeof compiled.handle === "string" ? (compiled.handle as string) : null;
  record(
    "spirv_compiled",
    spirv !== null && compiled.handle_class === "RDShaderSPIRV",
    spirv === null ? `no handle in ${JSON.stringify(compiled)}` : `${compiled.handle_class} as ${spirv}`,
  );
  if (spirv === null) {
    return;
  }

  // Read the compile error before trusting the SPIRV. A GLSL mistake otherwise
  // surfaces three calls later as an unrelated-looking failure.
  const compileError = await callJson(client, "gd_scene_node_call", {
    target: spirv,
    method: "get_stage_compile_error",
    args: [computeStage],
  });
  record(
    "spirv_has_no_compile_error",
    compileError.result === "",
    `get_stage_compile_error(SHADER_STAGE_COMPUTE) -> ${JSON.stringify(compileError.result)}`,
  );
  if (compileError.result !== "") {
    return;
  }

  const shader = await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "shader_create_from_spirv",
    args: [objectArg(spirv), ""],
  });
  record("shader_created", isRid(shader.result), `shader_create_from_spirv -> ${JSON.stringify(shader.result)}`);
  if (!isRid(shader.result)) {
    return;
  }

  const bytes = floatsToBytes(INPUT);
  const buffer = await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "storage_buffer_create",
    args: [bytes.length, { __type: "PackedByteArray", data: bytes }],
  });
  record(
    "buffer_created_with_input_data",
    isRid(buffer.result),
    `storage_buffer_create(${bytes.length}, ${JSON.stringify(INPUT)} as bytes) -> ${JSON.stringify(buffer.result)}`,
  );
  if (!isRid(buffer.result)) {
    return;
  }

  const uniform = await callJson(client, "gd_scene_object", {
    op: "create",
    class: "RDUniform",
    properties: { uniform_type: storageBuffer, binding: 0 },
  });
  await callJson(client, "gd_scene_node_call", {
    target: uniform.handle,
    method: "add_id",
    args: [buffer.result],
  });
  record(
    "uniform_holds_the_buffer_rid",
    typeof uniform.handle === "string",
    `RDUniform as ${uniform.handle}, add_id(${(buffer.result as Rid).id})`,
  );

  // The question. gd_classdb reports this parameter as a bare `Array` with no
  // element class, so the untyped array an args list builds is the only thing a
  // caller can pass; whether the engine converts it is what the readback
  // further down settles.
  const mark = outputMark();
  const uniformSet = await callRaw(client, "gd_scene_node_call", {
    target: device,
    method: "uniform_set_create",
    args: [[objectArg(uniform.handle as string)], shader.result, 0],
  });
  const printed = await outputSince(mark);
  const setResult = uniformSet.isError ? null : (JSON.parse(uniformSet.text).result as unknown);
  const quoted = printed === "" ? "" : `; engine printed: ${printed}`;
  record(
    "an_untyped_array_satisfies_a_typed_array_parameter",
    !uniformSet.isError && isRid(setResult),
    uniformSet.isError
      ? `refused: ${uniformSet.text}`
      : `uniform_set_create([RDUniform], shader, 0) -> ${JSON.stringify(setResult)}${quoted}`,
  );
  if (!isRid(setResult)) {
    return;
  }

  const pipeline = await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "compute_pipeline_create",
    args: [shader.result, []],
  });
  record("pipeline_created", isRid(pipeline.result), `compute_pipeline_create -> ${JSON.stringify(pipeline.result)}`);
  if (!isRid(pipeline.result)) {
    return;
  }

  const list = await callJson(client, "gd_scene_node_call", { target: device, method: "compute_list_begin" });
  const listId = typeof list.result === "number" ? list.result : null;
  record("compute_list_begun", listId !== null, `compute_list_begin() -> ${JSON.stringify(list.result)}`);
  if (listId === null) {
    return;
  }

  await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "compute_list_bind_compute_pipeline",
    args: [listId, pipeline.result],
  });
  await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "compute_list_bind_uniform_set",
    args: [listId, setResult, 0],
  });
  await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "compute_list_dispatch",
    args: [listId, GROUPS_X, 1, 1],
  });
  await callJson(client, "gd_scene_node_call", { target: device, method: "compute_list_end" });
  await callJson(client, "gd_scene_node_call", { target: device, method: "submit" });
  await callJson(client, "gd_scene_node_call", { target: device, method: "sync" });
  record("dispatched_and_synced", true, `${GROUPS_X} group of ${LOCAL_SIZE_X} threads over ${INPUT.length} floats`);

  const read = await callJson(client, "gd_scene_node_call", {
    target: device,
    method: "buffer_get_data",
    args: [buffer.result, 0, bytes.length],
  });
  const output = Array.isArray(read.result) ? bytesToFloats(read.result as number[]) : null;
  const expected = INPUT.map((value) => value * 2);
  record(
    "the_shader_doubled_every_element",
    output !== null && output.length === expected.length && expected.every((value, index) => output[index] === value),
    output === null
      ? `buffer_get_data returned ${JSON.stringify(read.result)}`
      : `${JSON.stringify(INPUT)} -> ${JSON.stringify(output)}, expected ${JSON.stringify(expected)}`,
  );

  // The other side of the same question, and the reason the check above is not
  // the whole finding: if the engine accepts an untyped array it must be doing
  // something with the element type, and what it does with a wrong one is what
  // a caller who mistypes a handle will actually see. The RDShaderSource from
  // the top of the chain is a live object of the wrong class.
  const wrongMark = outputMark();
  const wrongType = await callRaw(client, "gd_scene_node_call", {
    target: device,
    method: "uniform_set_create",
    args: [[objectArg(source.handle as string)], shader.result, 0],
  });
  const wrongPrinted = await outputSince(wrongMark);
  const wrongResult = wrongType.isError ? null : (JSON.parse(wrongType.text).result as Rid | null);
  // RID(0) is the invalid RID, and it is still a well-formed tagged RID on the
  // wire, so "an RID came back" is not the same as "a uniform set was made".
  const wrongRefused = wrongType.isError || wrongResult?.id === "0";
  record(
    "a_wrong_element_type_is_refused",
    wrongRefused,
    wrongType.isError
      ? `refused: ${wrongType.text}`
      : `uniform_set_create([RDShaderSource], shader, 0) -> ${JSON.stringify(wrongResult)}${wrongPrinted === "" ? "" : `; engine printed: ${wrongPrinted.split("\n")[0]}`}`,
  );

  for (const rid of [setResult, pipeline.result, shader.result, buffer.result]) {
    await callJson(client, "gd_scene_node_call", { target: device, method: "free_rid", args: [rid] });
  }
  record("every_rid_freed", true, "uniform set, pipeline, shader, and buffer released");
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
    godotCommand(godot, ["--editor", "--path", "example-project", "--rendering-method", "forward_plus"], true),
    { cwd: repoRoot, env: conduitEnv(RUNTIME_DIR), stdout: "pipe", stderr: "pipe" },
  );
  drain(editor.stdout as ReadableStream<Uint8Array> | null);
  drain(editor.stderr as ReadableStream<Uint8Array> | null);

  let client: Client | null = null;
  try {
    const endpoint = await waitForEditor(RUNTIME_DIR, 90_000);
    record("editor_bound", true, `editor bridge bound at ${endpointKey(endpoint)}`);

    client = await connectBroker(RUNTIME_DIR, ["--disable-eval"]);
    await assertEvalIsGone(client);
    await computeChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 20 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 20 checks passed.");
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
