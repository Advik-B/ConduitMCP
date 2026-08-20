#!/usr/bin/env bun
// Live acceptance for phase 15, editor plugins and translations: enabling and
// disabling an addon, and registering a project's translations
// (docs/coverage-matrix.md, "Roadmap"; whitepaper section 8, "enable or disable
// editor plugins" and "manage translations", the last two items that table
// listed as absent).
//
// The load-bearing detail, as in every runner since phase 10, is that the
// broker runs with --disable-eval. Both capabilities are reachable from
// GDScript, so a runner with gd_editor_eval registered would pass whether or
// not these tools existed. It is also the honest configuration: gd_editor_eval
// is off unless explicitly enabled, so in a default deployment neither was
// merely awkward before this, both were unreachable.
//
// Two things this runner measures rather than assumes. A plugin directory
// written before the editor starts is discovered by its first filesystem scan,
// so the fixture is generated like phase 13's PNG rather than checked in. And
// enabling runs the plugin's _enter_tree inside a headless editor process,
// which the marker file is there to prove: the enabled flag can be set while
// the plugin never loaded.
//
// Headless editor only: both write project.godot through the editor's
// ProjectSettings, and a running game has neither an EditorInterface nor a
// writable project.
//
// Run with `bun tests/evals/phase15_plugins_i18n.ts` (needs GODOT_BIN).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const RUNTIME_DIR = runtimeDir("p15");
const EDITOR_LOG = join(RUNTIME_DIR, "editor.log");

const PLUGIN = "phase15_marker";
const PLUGIN_DIR = join(exampleProject, "addons", PLUGIN);
const MARKER_RES = "res://conduit_phase15_marker.txt";
const CSV_RES = "res://conduit_phase15.csv";
const PROJECT_GODOT = join(exampleProject, "project.godot");

// The remap fixture never has to exist as a file: a remap is an entry in a
// project-settings table, and the engine resolves the path only when something
// loads the resource.
const REMAP_RESOURCE = "res://conduit_phase15_banner.png";
const REMAP_VARIANT = "res://conduit_phase15_banner.fr.png";

// A two-locale table. The csv_translation importer turns this into a sibling
// .translation resource per column, which is what gets registered.
const CSV_SOURCE = "keys,en,fr\nCONDUIT_PHASE15_GREETING,Hello,Bonjour\n";

const PLUGIN_CFG = `[plugin]

name="Conduit Phase 15 Marker"
description="Acceptance fixture: records its own load and unload in a marker file."
author="Conduit"
version="1.0"
script="phase15_marker.gd"
`;

// Deliberately UI-free. set_plugin_enabled runs _enter_tree synchronously
// inside the editor process, so anything that touched a dock or a control
// would risk a broken editor instead of a clean tool error, and this runs
// headless besides. It appends rather than writing and deleting: _exit_tree
// also fires at editor shutdown, so "the file is gone" would not be evidence
// that disable unloaded anything.
const PLUGIN_SCRIPT = `@tool
extends EditorPlugin

const MARKER := "${MARKER_RES}"

func _enter_tree() -> void:
	_append("entered")

func _exit_tree() -> void:
	_append("exited")

func _append(line: String) -> void:
	var existing := ""
	if FileAccess.file_exists(MARKER):
		existing = FileAccess.get_file_as_string(MARKER)
	var file := FileAccess.open(MARKER, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(existing)
	file.store_line(line)
	file.close()
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

/**
 * The bridge globalizes res:// paths for itself; the runner has no engine to
 * ask, so it joins onto the known project directory the way every other runner
 * builds its fixture paths.
 */
function hostPath(resPath: string): string {
  return join(exampleProject, resPath.slice("res://".length));
}

function projectGodot(): string {
  return readFileSync(PROJECT_GODOT, "utf8");
}

/**
 * The stored value of one project setting, read out of project.godot itself,
 * or null if the file does not carry it.
 *
 * project.godot is an INI file and a setting key is split at its first slash:
 * `internationalization/locale/translations` is stored as `locale/translations`
 * under `[internationalization]`, so the dotted key never appears in the file
 * as written. Grepping for it finds nothing whether or not the setting
 * persisted, which is a check that passes and proves nothing.
 *
 * A dictionary value spans several lines, so the value runs to the next key
 * rather than to the end of the line: reading one line back would return a
 * bare `{` for exactly the remap table this runner has to inspect.
 */
function settingValue(key: string): string | null {
  const slash = key.indexOf("/");
  const section = key.slice(0, slash);
  const name = key.slice(slash + 1);
  const text = projectGodot();
  const header = `[${section}]`;
  const start = text.indexOf(header);
  if (start < 0) {
    return null;
  }
  const rest = text.slice(start + header.length);
  const end = rest.indexOf("\n[");
  const lines = (end < 0 ? rest : rest.slice(0, end)).split("\n");
  const first = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (first < 0) {
    return null;
  }
  const collected = [lines[first]!.slice(name.length + 1)];
  for (const line of lines.slice(first + 1)) {
    if (/^[A-Za-z_][\w./]*=/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function markerLines(): string[] {
  const file = hostPath(MARKER_RES);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Poll until `probe` returns something truthy, or give up and return null. */
async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      console.log(`  (gave up waiting for ${what} after ${timeoutMs} ms)`);
      return null;
    }
    await Bun.sleep(500);
  }
}

function writePluginFixture(): void {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(join(PLUGIN_DIR, "plugin.cfg"), PLUGIN_CFG);
  writeFileSync(join(PLUGIN_DIR, `${PLUGIN}.gd`), PLUGIN_SCRIPT);
}

/**
 * The fixture plugin, the marker it writes, the CSV, and everything the
 * csv_translation importer generated from it. The imported artifacts live
 * under `.godot/`, which is git-ignored, so leaving them behind would
 * accumulate silently across CI runs rather than showing up in a diff.
 */
function cleanupFixtures(): void {
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
  rmSync(hostPath(MARKER_RES), { force: true });
  for (const entry of readdirSync(exampleProject)) {
    if (entry.startsWith("conduit_phase15")) {
      rmSync(join(exampleProject, entry), { force: true });
    }
  }
  const imported = join(exampleProject, ".godot", "imported");
  if (existsSync(imported)) {
    for (const entry of readdirSync(imported)) {
      if (entry.startsWith("conduit_phase15")) {
        rmSync(join(imported, entry), { force: true });
      }
    }
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
  cleanupFixtures();

  // project.godot is tracked, and an enabled editor plugin is not inert residue
  // the way phase 8's leftover input action is: every later editor runner would
  // launch with the fixture loading. Restoring the exact bytes in the finally
  // block survives a mid-run crash, which a tool-level undo would not.
  const projectSnapshot = readFileSync(PROJECT_GODOT);

  writePluginFixture();

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
    await pluginChecks(client);
    await translationChecks(client);
    await errorChecks(client);
  } finally {
    await client?.close().catch(() => {});
    killTree(editor);
    await editor.exited.catch(() => {});
    writeFileSync(PROJECT_GODOT, projectSnapshot);
    cleanupFixtures();
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  console.log("\n=== Phase 15 acceptance summary ===");
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll phase 15 checks passed.");
}

/**
 * The premise of the whole runner. If gd_editor_eval is registered, every check
 * below could be passing for the wrong reason.
 */
async function assertEvalIsGone(client: Client): Promise<void> {
  const names = (await client.listTools()).tools.map((t) => t.name);
  const evals = names.filter((n) => n === "gd_game_eval" || n === "gd_editor_eval");
  record("eval_disabled", evals.length === 0, `--disable-eval left no eval tools registered (${names.length} tools)`);
  const missing = ["gd_editor_plugin", "gd_translations"].filter((n) => !names.includes(n));
  record(
    "phase15_tools_registered",
    missing.length === 0,
    missing.length === 0 ? "gd_editor_plugin and gd_translations are on the default surface" : `missing ${missing.join(", ")}`,
  );
}

async function pluginChecks(client: Client): Promise<void> {
  console.log("\nListing, enabling, and disabling an editor plugin ...");

  const listed = await callJson(client, "gd_editor_plugin", { op: "list" });
  const fixture = (listed.plugins ?? []).find((p: any) => p.plugin === PLUGIN);
  record(
    "plugin_list_reports_the_fixture",
    Boolean(fixture) && fixture.enabled === false && fixture.name === "Conduit Phase 15 Marker",
    fixture
      ? `${fixture.plugin} v${fixture.version} named "${fixture.name}", enabled=${fixture.enabled}`
      : `no ${PLUGIN} among ${(listed.plugins ?? []).map((p: any) => p.plugin).join(", ") || "nothing"}`,
  );

  const enabled = await callJson(client, "gd_editor_plugin", { op: "enable", plugin: PLUGIN });
  // The setting can be written while _enter_tree never ran, so the marker is
  // the assertion that carries the weight; the enabled flag alone would not.
  const entered = await waitFor("the plugin's _enter_tree marker", () => (markerLines().includes("entered") ? true : null), 15_000);
  record(
    "plugin_enable_loads_it",
    enabled.enabled === true && enabled.previous === false && entered === true,
    `enabled=${enabled.enabled} (was ${enabled.previous}), marker=[${markerLines().join(", ")}]`,
  );

  const afterEnable = settingValue("editor_plugins/enabled");
  record(
    "plugin_enable_persists",
    afterEnable !== null && afterEnable.includes(PLUGIN),
    `editor_plugins/enabled in project.godot = ${afterEnable ?? "(absent)"}`,
  );

  const relisted = await callJson(client, "gd_editor_plugin", { op: "list" });
  const nowOn = (relisted.plugins ?? []).find((p: any) => p.plugin === PLUGIN);
  record("plugin_list_reflects_the_change", nowOn?.enabled === true, `list reports enabled=${nowOn?.enabled}`);

  const disabled = await callJson(client, "gd_editor_plugin", { op: "disable", plugin: PLUGIN });
  const exited = await waitFor("the plugin's _exit_tree marker", () => (markerLines().includes("exited") ? true : null), 15_000);
  const afterDisable = settingValue("editor_plugins/enabled");
  record(
    "plugin_disable_unloads_it",
    disabled.enabled === false && disabled.previous === true && exited === true && !(afterDisable ?? "").includes(PLUGIN),
    `enabled=${disabled.enabled} (was ${disabled.previous}), marker=[${markerLines().join(", ")}], editor_plugins/enabled = ${afterDisable ?? "(absent)"}`,
  );
}

async function translationChecks(client: Client): Promise<void> {
  console.log("\nImporting a CSV translation and registering it ...");

  await callJson(client, "gd_asset_add", {
    path: CSV_RES,
    data_base64: Buffer.from(CSV_SOURCE, "utf8").toString("base64"),
  });

  // The csv_translation importer writes one sibling .translation per locale
  // column. Which locales it names is the importer's business, so the runner
  // reads them off disk rather than predicting them.
  const generated = await waitFor(
    "the generated .translation resources",
    () => {
      const found = readdirSync(exampleProject).filter(
        (entry) => entry.startsWith("conduit_phase15.") && entry.endsWith(".translation"),
      );
      return found.length > 0 ? found.sort() : null;
    },
    60_000,
  );
  record(
    "csv_imports_to_translation_resources",
    (generated?.length ?? 0) >= 2,
    generated ? `import produced ${generated.join(", ")}` : "no .translation resource appeared beside the CSV",
  );

  const translationRes = `res://${(generated ?? ["conduit_phase15.en.translation"])[0]}`;

  const added = await callJson(client, "gd_translations", { op: "add", path: translationRes });
  const listedAfterAdd = await callJson(client, "gd_translations", { op: "list" });
  const storedList = settingValue("internationalization/locale/translations");
  record(
    "translations_add_registers",
    added.translations.includes(translationRes) &&
      listedAfterAdd.translations.includes(translationRes) &&
      (storedList ?? "").includes(translationRes),
    `list reports ${listedAfterAdd.translations.length} translation(s); project.godot = ${storedList ?? "(absent)"}`,
  );

  await callJson(client, "gd_translations", {
    op: "remap_add",
    resource: REMAP_RESOURCE,
    variant: REMAP_VARIANT,
    locale: "fr",
  });
  const withRemap = await callJson(client, "gd_translations", { op: "list" });
  const remapEntries = withRemap.remaps?.[REMAP_RESOURCE] ?? [];
  const storedRemaps = settingValue("internationalization/locale/translation_remaps");
  record(
    "translation_remap_round_trips",
    remapEntries.some((e: any) => e.locale === "fr" && e.variant === REMAP_VARIANT) &&
      (storedRemaps ?? "").includes(REMAP_VARIANT),
    `remaps[${REMAP_RESOURCE}] = ${JSON.stringify(remapEntries)}; project.godot = ${storedRemaps ?? "(absent)"}`,
  );

  await callJson(client, "gd_translations", { op: "remap_remove", resource: REMAP_RESOURCE, locale: "fr" });
  const withoutRemap = await callJson(client, "gd_translations", { op: "list" });
  record(
    "translation_remap_removes",
    withoutRemap.remaps?.[REMAP_RESOURCE] === undefined &&
      !(settingValue("internationalization/locale/translation_remaps") ?? "").includes(REMAP_VARIANT),
    `remap table after removal: ${JSON.stringify(withoutRemap.remaps)}`,
  );

  const locales = await callJson(client, "gd_translations", { op: "set_locale", fallback: "fr", test: "fr" });
  const storedFallback = settingValue("internationalization/locale/fallback");
  const storedTest = settingValue("internationalization/locale/test");
  record(
    "translation_locale_round_trips",
    locales.fallback === "fr" &&
      locales.test === "fr" &&
      (storedFallback ?? "").includes("fr") &&
      (storedTest ?? "").includes("fr"),
    `fallback=${locales.fallback}, test=${locales.test}; project.godot fallback=${storedFallback ?? "(absent)"} test=${storedTest ?? "(absent)"}`,
  );

  const removed = await callJson(client, "gd_translations", { op: "remove", path: translationRes });
  const finalList = await callJson(client, "gd_translations", { op: "list" });
  const storedAfterRemove = settingValue("internationalization/locale/translations");
  record(
    "translations_remove_clears",
    removed.removed === true && !finalList.translations.includes(translationRes) && storedAfterRemove === null,
    `list reports ${finalList.translations.length} translation(s); project.godot = ${storedAfterRemove ?? "(absent)"}`,
  );
}

async function errorChecks(client: Client): Promise<void> {
  console.log("\nChecking the shape of the rejections ...");

  const asPath = await callExpectingError(client, "gd_editor_plugin", { op: "enable", plugin: "res://addons/x/plugin.cfg" });
  record(
    "a_plugin_path_is_rejected_as_a_name",
    asPath.includes("directory name"),
    `a plugin.cfg path is refused: ${asPath.slice(0, 110)}`,
  );

  const unknown = await callExpectingError(client, "gd_editor_plugin", { op: "enable", plugin: "conduit_phase15_absent" });
  record("an_unknown_plugin_is_rejected", unknown.includes("no plugin at"), `${unknown.slice(0, 110)}`);

  const outside = await callExpectingError(client, "gd_translations", { op: "add", path: "/etc/passwd" });
  record("a_translation_outside_the_project_is_rejected", outside.includes("res://"), `${outside.slice(0, 110)}`);

  const absent = await callExpectingError(client, "gd_translations", { op: "remove", path: "res://never_registered.translation" });
  record(
    "removing_an_unregistered_translation_is_an_error",
    absent.includes("no registered translation"),
    `${absent.slice(0, 110)}`,
  );

  const noTarget = await callExpectingError(client, "gd_translations", { op: "set_locale" });
  record("set_locale_needs_something_to_set", noTarget.includes("fallback"), `${noTarget.slice(0, 110)}`);
}

async function connectBroker(extraArgs: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(repoRoot, "broker", "src", "index.ts"), ...extraArgs],
    env: conduitEnv(RUNTIME_DIR),
  });
  const client = new Client({ name: "phase15-acceptance", version: "0.7.3" });
  await client.connect(transport);
  return client;
}

main().catch((error) => {
  console.error(`\nRunner failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
