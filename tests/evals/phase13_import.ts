#!/usr/bin/env bun
// Live acceptance for phase 13, import settings: reading and writing an asset's
// .import options and reimporting from them (docs/coverage-matrix.md, "Roadmap";
// whitepaper section 8, "read and set import settings").
//
// The load-bearing detail, as in the phase 10 runner, is that the broker runs
// with --disable-eval. Import options are reachable from GDScript, so a runner
// with gd_editor_eval registered would pass whether or not gd_import_settings
// existed. It is also the honest configuration to test: gd_editor_eval is off
// unless explicitly enabled, so in a default deployment an import option was
// not merely awkward to change before this, it was unreachable.
//
// Headless editor only: import is an editor-filesystem operation and the game
// bridge has no pipeline to drive.
//
// Run with `bun tests/evals/phase13_import.ts` (needs GODOT_BIN).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

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

const RUNTIME_DIR = runtimeDir("p13");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");
const ASSET_RES = "res://conduit_phase13.png";
const ASSET_FILE = hostPath(ASSET_RES);

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

/**
 * The bridge globalizes res:// paths for itself; the runner has no engine to
 * ask, so it joins onto the known project directory the way every other runner
 * builds its fixture paths.
 */
function hostPath(resPath: string): string {
  return join(exampleProject, resPath.slice("res://".length));
}

function hashOf(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

/**
 * Read import settings once the pipeline has stopped touching them.
 *
 * The editor rewrites the `.import` sidecar itself as the last step of an
 * import, so a read taken the instant the sidecar appears can be stale, and --
 * worse -- a write issued against it is silently clobbered by that rewrite. A
 * reading counts as settled only when the options, the artifact it names, and
 * that artifact's bytes are all unchanged across two reads.
 */
async function settled(
  client: Client,
  what: string,
  accept: (settings: any) => boolean = () => true,
  soft = false,
): Promise<any> {
  const attempt = async () => {
    const first = await callJson(client, "gd_import_settings", { path: ASSET_RES });
    if (!first.importer || typeof first.imported_path !== "string") {
      return null;
    }
    const hash = hashOf(hostPath(first.imported_path));
    if (hash === null) {
      return null;
    }
    await Bun.sleep(750);
    const second = await callJson(client, "gd_import_settings", { path: ASSET_RES });
    if (second.imported_path !== first.imported_path) {
      return null;
    }
    if (JSON.stringify(second.params) !== JSON.stringify(first.params)) {
      return null;
    }
    if (hashOf(hostPath(second.imported_path)) !== hash) {
      return null;
    }
    second.artifact_sha256 = hash;
    return accept(second) ? second : null;
  };
  if (!soft) {
    return waitFor(what, 90_000, attempt);
  }
  // A soft wait turns a timeout into a recorded FAIL rather than aborting the
  // run, so the checks after it still report.
  try {
    return await waitFor(what, 90_000, attempt);
  } catch {
    return null;
  }
}

async function waitFor<T>(what: string, timeoutMs: number, attempt: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt completed";
  for (;;) {
    try {
      const value = await attempt();
      if (value !== null) {
        return value;
      }
      last = "condition not met yet";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}: ${last}`);
    }
    await Bun.sleep(250);
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

  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });
  cleanupAsset();

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
    const settings = await readChecks(client);
    await writeChecks(client, settings);
    await errorChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    cleanupAsset();
  }

  console.log("\n=== Phase 13 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 13 checks passed.");
}

/**
 * The source, its sidecar, and the artifacts the import produced. The last of
 * these live under `.godot/`, which is git-ignored, so leaving them behind
 * would accumulate silently across CI runs rather than showing up in a diff.
 */
function cleanupAsset(): void {
  rmSync(ASSET_FILE, { force: true });
  rmSync(`${ASSET_FILE}.import`, { force: true });
  const imported = join(exampleProject, ".godot", "imported");
  if (!existsSync(imported)) {
    return;
  }
  for (const entry of readdirSync(imported)) {
    if (entry.startsWith("conduit_phase13.")) {
      rmSync(join(imported, entry), { force: true });
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
    "import_settings_registered",
    names.includes("gd_import_settings"),
    names.includes("gd_import_settings") ? "gd_import_settings is on the default surface" : "gd_import_settings is missing",
  );
}

/** Ingest a texture, then read back the options the importer gave it. */
async function readChecks(client: Client): Promise<any> {
  console.log("\nIngesting a texture and reading its import settings ...");
  const png = makePng(64);
  const added = await callJson(client, "gd_asset_add", {
    path: ASSET_RES,
    data_base64: png.toString("base64"),
  });

  // gd_asset_add's own scan discovers the file but does not import it: only
  // scan_sources() does, and that is gd_asset_reimport (docs/api-gaps.md).
  // Chaining the two is what makes ingestion deterministic here rather than
  // dependent on the editor's periodic source scan.
  await callJson(client, "gd_asset_reimport", { path: ASSET_RES });

  // Polled rather than asserted outright even so: the reimport is queued behind
  // the scan, and is_scanning() goes false before it has run.
  const settings = await settled(client, "the ingest import to settle");

  record(
    "asset_imported",
    added.bytes_written === png.length && settings.import_path === `${ASSET_RES}.import`,
    `wrote ${added.bytes_written} bytes, sidecar at ${settings.import_path}`,
  );

  const params = settings.params as Record<string, unknown>;
  record(
    "import_settings_reads_params",
    settings.importer === "texture" && typeof params === "object" && "compress/mode" in params,
    `importer=${settings.importer}, type=${settings.type}, ${Object.keys(params).length} options including compress/mode=${params["compress/mode"]}`,
  );

  record(
    "import_settings_names_the_artifact",
    typeof settings.imported_path === "string" && settings.artifact_sha256 !== null,
    `${settings.imported_path} present on disk (sha256 ${settings.artifact_sha256})`,
  );

  return settings;
}

/** The acceptance criterion: change an option and see the reimport happen. */
async function writeChecks(client: Client, before: any): Promise<void> {
  console.log("\nWriting an import setting ...");
  const optionsBefore = Object.keys(before.params).length;
  const artifactBefore = before.imported_path as string;
  const hashBefore = before.artifact_sha256 as string;

  // 0 is lossless and 1 is lossy, and neither unlocks options the other lacks,
  // so this check stays independent of whether an importer omits conditional
  // options from [params]. Read the current value rather than assuming it.
  const modeBefore = Number(before.params["compress/mode"] ?? 0);
  const modeAfter = modeBefore === 0 ? 1 : 0;

  const written = await callJson(client, "gd_import_settings", {
    path: ASSET_RES,
    op: "set",
    params: { "compress/mode": modeAfter },
  });
  record(
    "import_settings_set_reports_its_work",
    written.previous?.["compress/mode"] === modeBefore &&
      written.params?.["compress/mode"] === modeAfter &&
      written.reimported === true &&
      written.undoable === false,
    `compress/mode ${modeBefore} -> ${modeAfter}, reimported=${written.reimported}, undoable=${written.undoable}`,
  );

  // The artifact filename is derived from the source path rather than the
  // settings, so a reimport rewrites the same file rather than renaming it.
  // Assert on either and say which one fired, so a future engine that renames
  // instead still proves the same thing.
  const reimported = await settled(
    client,
    "the reimport to rewrite the artifact",
    (s) =>
      Number(s.params["compress/mode"]) === modeAfter &&
      (s.imported_path !== artifactBefore || s.artifact_sha256 !== hashBefore),
    true,
  );
  record(
    "import_settings_set_reimports",
    reimported !== null,
    reimported === null
      ? `compress/mode read back as ${modeAfter} but ${artifactBefore} never changed`
      : reimported.imported_path !== artifactBefore
        ? `artifact renamed ${artifactBefore} -> ${reimported.imported_path}`
        : `artifact rewritten in place (sha256 ${hashBefore} -> ${reimported.artifact_sha256})`,
  );

  const after = reimported ?? (await settled(client, "the sidecar to settle"));
  const optionsAfter = Object.keys(after.params).length;
  record(
    "option_set_is_stable_across_a_write",
    optionsAfter === optionsBefore,
    `[params] carried ${optionsBefore} options before and ${optionsAfter} after; the importer writes its full set up front, so rejecting an unknown key cannot reject a legitimate one`,
  );

  // Batching: write without reimporting, so several options can be changed and
  // the pipeline run once.
  const deferred = await callJson(client, "gd_import_settings", {
    path: ASSET_RES,
    op: "set",
    params: { "compress/mode": modeBefore },
    reimport: false,
  });
  const readBack = await callJson(client, "gd_import_settings", { path: ASSET_RES });
  record(
    "import_settings_set_can_defer_the_reimport",
    deferred.reimported === false && Number(readBack.params["compress/mode"]) === modeBefore,
    `reimport: false wrote compress/mode=${readBack.params["compress/mode"]} without running the pipeline`,
  );
  await callJson(client, "gd_asset_reimport", { path: ASSET_RES });
  await settled(client, "the restored setting to reimport", (s) => Number(s.params["compress/mode"]) === modeBefore);
}

async function errorChecks(client: Client): Promise<void> {
  console.log("\nError shapes ...");

  const unknown = await callExpectingError(client, "gd_import_settings", {
    path: ASSET_RES,
    op: "set",
    params: { "compress/nonsense": 1 },
  });
  record(
    "unknown_option_is_rejected_not_inserted",
    unknown.includes("no import option") && unknown.includes("op get"),
    "a misspelled option is an error naming the alternative, not a silent insert",
  );

  const notImported = await callExpectingError(client, "gd_import_settings", { path: "res://main.tscn" });
  record(
    "non_imported_file_says_so",
    notImported.includes("import settings") && notImported.includes("scenes"),
    "a scene reports that it has no sidecar rather than failing opaquely",
  );

  const missing = await callExpectingError(client, "gd_import_settings", { path: "res://no_such_asset.png" });
  record("missing_file_is_distinct", missing.includes("no file at"), "a path with no file reads differently from one with no sidecar");

  const outside = await callExpectingError(client, "gd_import_settings", { path: "/etc/passwd" });
  record("path_outside_the_project_rejected", outside.includes("res://"), "an absolute host path is refused at the boundary");
}

/**
 * A 64x64 RGBA gradient, built here rather than checked in: example-project has
 * no imported asset, and the 1x1 PNG the phase 3 runner uses is too small to
 * tell a lossless import from a lossy one by its bytes.
 */
function makePng(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      raw[offset++] = (x * 4) & 0xff;
      raw[offset++] = (y * 4) & 0xff;
      raw[offset++] = ((x ^ y) * 4) & 0xff;
      raw[offset++] = 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase13-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
